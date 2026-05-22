import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    createWorkspace,
    getMeeting,
    joinMeeting
} from '../../lib/webmeetStore.mjs';

let tempRoot = '';
const originalDataDir = process.env.WEBMEET_DATA_DIR;
const originalMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-livekit-presence-'));
    process.env.WEBMEET_DATA_DIR = path.join(tempRoot, 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
});

afterEach(() => {
    if (originalDataDir === undefined) {
        delete process.env.WEBMEET_DATA_DIR;
    } else {
        process.env.WEBMEET_DATA_DIR = originalDataDir;
    }
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
    } else {
        process.env.PLOINKY_WEBMEET_MASTER_KEY = originalMasterKey;
    }
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('meeting participants include LiveKit participants and pending joined members', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Presence source room',
        authInfo
    });
    joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin',
        authInfo
    });
    joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'User',
        participantId: 'participant-user',
        authInfo: {
            user: {
                id: 'local:user',
                username: 'user',
                roles: ['user']
            }
        }
    });

    context.listLiveKitParticipants = async () => [{
        identity: 'participant-user',
        name: 'User',
        kind: 'STANDARD',
        attributes: { webmeetUserId: 'local:user' }
    }];

    const details = await getMeeting(context, meeting.id, authInfo);

    assert.deepEqual(details.participants.map((entry) => entry.id), ['participant-user', 'participant-admin']);
    assert.equal(details.participants[0].attributes.webmeetUserId, 'local:user');
});

test('meeting participant projection fails when no LiveKit source is available', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Missing LiveKit source room',
        authInfo
    });

    await assert.rejects(
        () => getMeeting(context, meeting.id, authInfo),
        /LiveKit room API is not configured/
    );
});
