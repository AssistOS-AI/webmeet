import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    joinGuestMeeting,
    joinMeeting,
    leaveMeeting
} from '../../lib/webmeetStore.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import { decryptRoomPayload, loadRoomRecord } from '../../lib/store/roomRecords.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';

const ADMIN_AUTH = {
    user: { id: 'local:admin', username: 'admin', roles: ['admin'] }
};
const USER_A_AUTH = {
    user: { id: 'local:identity-a', username: 'identity-a', roles: ['user'] }
};
const USER_B_AUTH = {
    user: { id: 'local:identity-b', username: 'identity-b', roles: ['user'] }
};

function guestAuth(roomId, guestId) {
    const subject = `user:guest:${guestId}`;
    return {
        invocation: {
            issuer: 'ploinky-router',
            subject,
            actor: { kind: 'guest', id: subject, roles: ['guest'] },
            caller: { kind: 'user', id: subject, roles: ['guest'] },
            scope: [`public:webmeet:room:${roomId}`],
            tool: 'webmeet_room_join_guest'
        }
    };
}

async function withStoreFixture(t) {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-participant-owner-'));
    process.env.WEBMEET_DATA_DIR = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    t.after(async () => {
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
        await fs.rm(root, { recursive: true, force: true });
    });
    return installEdgeJoinFixture(await createStoreContext(root));
}

async function readPayload(context, roomId) {
    return decryptRoomPayload(context, await loadRoomRecord(context, roomId));
}

test('authenticated participant identity stays bound to its first user across refresh and rejoin', async (t) => {
    const context = await withStoreFixture(t);
    const room = await createMeeting(context, {
        title: 'Authenticated ownership',
        roomType: 'team',
        authInfo: ADMIN_AUTH
    });
    const participantId = 'participant-auth-collision';

    const initial = await joinMeeting(context, {
        meetingId: room.id,
        displayName: 'Identity A',
        participantId,
        authInfo: USER_A_AUTH
    });
    assert.equal(initial.participantIdentity, participantId);
    assert.ok(initial.participantToken);

    const refreshed = await joinMeeting(context, {
        meetingId: room.id,
        displayName: 'Identity A refreshed',
        participantId,
        authInfo: USER_A_AUTH
    });
    assert.equal(refreshed.participantIdentity, participantId);
    assert.equal(refreshed.participant.displayName, 'Identity A refreshed');
    assert.ok(refreshed.participantToken);

    await assert.rejects(
        () => joinMeeting(context, {
            meetingId: room.id,
            displayName: 'Identity B takeover',
            participantId,
            authInfo: USER_B_AUTH
        }),
        /participant identity is already bound to another caller/
    );

    let payload = await readPayload(context, room.id);
    assert.equal(payload.members.find((entry) => entry.id === participantId)?.userId, USER_A_AUTH.user.id);
    assert.equal(payload.members.find((entry) => entry.id === participantId)?.displayName, 'Identity A refreshed');
    assert.deepEqual(payload.participantIdentityOwners.bindings, [{
        participantId,
        owner: { kind: 'authenticated-user', id: USER_A_AUTH.user.id },
        boundAt: payload.participantIdentityOwners.bindings[0].boundAt
    }]);

    await leaveMeeting(context, {
        meetingId: room.id,
        participantId,
        authInfo: USER_A_AUTH
    });
    await assert.rejects(
        () => joinMeeting(context, {
            meetingId: room.id,
            displayName: 'Identity B after leave',
            participantId,
            authInfo: USER_B_AUTH
        }),
        /participant identity is already bound to another caller/
    );

    const rejoined = await joinMeeting(context, {
        meetingId: room.id,
        displayName: 'Identity A rejoined',
        participantId,
        authInfo: USER_A_AUTH
    });
    assert.equal(rejoined.participant.userId, USER_A_AUTH.user.id);
    assert.equal(rejoined.participant.displayName, 'Identity A rejoined');
    payload = await readPayload(context, room.id);
    assert.equal(payload.participantIdentityOwners.bindings.length, 1);
});

test('guest participant identity requires a verified session and rejects guest/auth collisions', async (t) => {
    const context = await withStoreFixture(t);
    const room = await createMeeting(context, {
        title: 'Guest ownership',
        roomType: 'guest',
        authInfo: ADMIN_AUTH
    });
    const participantId = 'participant-guest-collision';
    const guestA = guestAuth(room.id, 'session-owner-a');
    const guestB = guestAuth(room.id, 'session-owner-b');

    await assert.rejects(
        () => joinGuestMeeting(context, {
            meetingId: room.id,
            displayName: 'Unbound guest',
            participantId
        }),
        /guest participant requires a verified guest session owner/
    );

    const initial = await dispatch('webmeet_room_join_guest', {
        roomId: room.id,
        displayName: 'Guest A',
        participantId
    }, context, guestA);
    assert.equal(initial.participantIdentity, participantId);
    assert.ok(initial.participantToken);

    const refreshed = await dispatch('webmeet_room_join_guest', {
        roomId: room.id,
        displayName: 'Guest A refreshed',
        participantId
    }, context, guestA);
    assert.equal(refreshed.participant.displayName, 'Guest A refreshed');
    assert.ok(refreshed.participantToken);

    await assert.rejects(
        () => dispatch('webmeet_room_join_guest', {
            roomId: room.id,
            displayName: 'Guest B takeover',
            participantId
        }, context, guestB),
        /participant identity is already bound to another caller/
    );
    await assert.rejects(
        () => joinMeeting(context, {
            meetingId: room.id,
            displayName: 'Authenticated takeover',
            participantId,
            authInfo: USER_B_AUTH
        }),
        /participant identity is already bound to another caller/
    );
    await assert.rejects(
        () => dispatch('webmeet_presence_heartbeat', {
            roomId: room.id,
            participantId
        }, context, guestB),
        /participant identity is already bound to another caller/
    );
    await assert.rejects(
        () => dispatch('webmeet_participant_avatar_update', {
            roomId: room.id,
            participantId,
            avatar: null
        }, context, guestB),
        /participant identity is already bound to another caller/
    );
    await assert.rejects(
        () => dispatch('webmeet_room_leave', {
            roomId: room.id,
            participantId
        }, context, guestB),
        /participant identity is already bound to another caller/
    );

    await dispatch('webmeet_room_leave', {
        roomId: room.id,
        participantId
    }, context, guestA);
    await assert.rejects(
        () => dispatch('webmeet_room_join_guest', {
            roomId: room.id,
            displayName: 'Guest B after leave',
            participantId
        }, context, guestB),
        /participant identity is already bound to another caller/
    );
    const rejoined = await dispatch('webmeet_room_join_guest', {
        roomId: room.id,
        displayName: 'Guest A rejoined',
        participantId
    }, context, guestA);
    assert.equal(rejoined.participantIdentity, participantId);
    assert.equal(rejoined.participant.displayName, 'Guest A rejoined');

    const payload = await readPayload(context, room.id);
    const participant = payload.members.find((entry) => entry.id === participantId);
    assert.equal(participant?.displayName, 'Guest A rejoined');
    assert.equal(participant?.guest, true);
    assert.deepEqual(payload.participantIdentityOwners.bindings[0].owner, {
        kind: 'guest-session',
        id: guestA.invocation.subject
    });
});

test('guest owner binding is exact to room scope and signed guest actor identity', async (t) => {
    const context = await withStoreFixture(t);
    const room = await createMeeting(context, {
        title: 'Guest validation',
        roomType: 'guest',
        authInfo: ADMIN_AUTH
    });
    const wrongScope = guestAuth('room_00000000-0000-0000-0000-000000000000', 'wrong-scope');
    const mismatchedActor = guestAuth(room.id, 'subject-a');
    mismatchedActor.invocation.actor.id = 'user:guest:subject-b';

    await assert.rejects(
        () => dispatch('webmeet_room_join_guest', {
            roomId: room.id,
            displayName: 'Wrong scope',
            participantId: 'wrong-scope-participant'
        }, context, wrongScope),
        /scope does not match this room/
    );
    await assert.rejects(
        () => dispatch('webmeet_room_join_guest', {
            roomId: room.id,
            displayName: 'Mismatched actor',
            participantId: 'mismatched-actor-participant'
        }, context, mismatchedActor),
        /verified guest session owner/
    );
});
