import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import {
    createGuestParticipantAuth,
    withGuestParticipantOwner
} from './participant-owner-fixture.mjs';

const ADMIN_AUTH = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
const USER_AUTH = { user: { id: 'local:user', username: 'user', roles: ['user'] } };
const GUEST_AUTH = { user: { id: 'guest:test', username: 'guest', roles: ['guest'] } };

test('WebMeet room list is dashboard-only and guest join is public-room-only', async () => {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-auth-contract-'));
    try {
        process.env.WEBMEET_DATA_DIR = root;
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const {
            createMeeting,
            createStoreContext,
            joinGuestMeeting,
            listMeetings
        } = await import('../../lib/webmeetStore.mjs');
        const context = installEdgeJoinFixture(await createStoreContext(root));
        const teamRoom = await createMeeting(context, { title: 'Team room', roomType: 'team', authInfo: ADMIN_AUTH });
        const publicRoom = await createMeeting(context, { title: 'Public room', roomType: 'guest', authInfo: ADMIN_AUTH });

        const userRooms = await listMeetings(context, '', USER_AUTH);
        assert.deepEqual(userRooms.map((entry) => entry.id).sort(), [publicRoom.id, teamRoom.id].sort());

        await assert.rejects(
            () => listMeetings(context, '', GUEST_AUTH),
            /sign in to view WebMeet rooms/
        );
        await assert.rejects(
            () => withGuestParticipantOwner(context, teamRoom.id, () => (
                joinGuestMeeting(context, { meetingId: teamRoom.id, displayName: 'Guest' })
            ), 'team-room-guest'),
            /does not support guest access/
        );
        const joined = await withGuestParticipantOwner(context, publicRoom.id, () => (
            joinGuestMeeting(context, { meetingId: publicRoom.id, displayName: 'Guest' })
        ), 'public-room-guest');
        assert.equal(joined.meeting.id, publicRoom.id);
        assert.equal(joined.participant.guest, true);
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
});

test('public room scoped invocation can publish guest participant avatar through the shared avatar tool', async () => {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-avatar-auth-contract-'));
    try {
        process.env.WEBMEET_DATA_DIR = root;
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const {
            createMeeting,
            createStoreContext,
            joinGuestMeeting
        } = await import('../../lib/webmeetStore.mjs');
        const { dispatch } = await import('../../tools/webmeet_tool.mjs');
        const context = installEdgeJoinFixture(await createStoreContext(root));
        const publicRoom = await createMeeting(context, {
            title: 'Public avatar room',
            roomType: 'guest',
            authInfo: ADMIN_AUTH
        });
        const joined = await withGuestParticipantOwner(context, publicRoom.id, () => (
            joinGuestMeeting(context, {
                meetingId: publicRoom.id,
                displayName: 'Guest Avatar',
                participantId: 'guest-avatar-participant'
            })
        ), 'avatar-guest');
        const guestAuth = createGuestParticipantAuth(publicRoom.id, 'avatar-guest');

        const updated = await dispatch('webmeet_participant_avatar_update', {
            roomId: publicRoom.id,
            participantId: joined.participantIdentity,
            avatar: {
                enabled: true,
                fallbackLetter: 'G',
                config: {
                    generated: true,
                    emotion: 'happy',
                    seed: 'guest-avatar-participant'
                }
            }
        }, context, guestAuth);

        assert.equal(updated.ok, true);
        assert.equal(updated.participantId, joined.participantIdentity);
        assert.equal(updated.profileAvatar.enabled, true);
        assert.equal(updated.profileAvatar.config.emotion, 'happy');
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
});
