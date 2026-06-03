import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AuthenticatedWebMeetRoomApi,
    GuestWebMeetRoomApi,
    createWebMeetRoomApi
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-api.js';
import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js';
import { buildWebMeetAvatarSource } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-avatar-override.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

function createRoomOptions(overrides = {}) {
    return {
        getSession: () => ({
            meeting: { id: 'room_00000000-0000-4000-8000-000000000001' },
            participantIdentity: 'participant-a'
        }),
        setSession: () => {},
        isGuestSession: () => false,
        connectLiveKit: async () => {},
        disconnectLiveKit: async () => {},
        runTool: async () => ({}),
        getRoom: () => null,
        getRoomAvatars: () => ({}),
        setRoomAvatar: () => {},
        applyRealtimeParticipantAvatar: () => {},
        publishRealtimePayload: async () => {},
        getCurrentActorId: () => '',
        getSelectedWorkspaceId: () => 'workspace-1',
        ...overrides
    };
}

test('room API routes authenticated room actions through protected WebMeet tools', async () => {
    const calls = [];
    const api = new AuthenticatedWebMeetRoomApi({
        runTool: async (name, args) => {
            calls.push({ name, args });
            return { ok: true, name };
        }
    });

    await api.joinMeeting({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' });
    await api.publishAvatar({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a', avatar: { enabled: true } });
    await api.leaveMeeting({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' });

    assert.deepEqual(calls.map((entry) => entry.name), [
        'webmeet_room_join',
        'webmeet_participant_avatar_update',
        'webmeet_room_leave'
    ]);
});

test('room API routes guest room actions through scoped room tools', async () => {
    const calls = [];
    const api = new GuestWebMeetRoomApi({
        runTool: async (name, args) => {
            calls.push({ name, args });
            return { ok: true, name };
        }
    });

    await api.publishAvatar({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a', avatar: { enabled: true } });
    await api.sendChat({ roomId: 'room_00000000-0000-4000-8000-000000000001', message: 'hello' });
    await api.leaveMeeting({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' });

    assert.deepEqual(calls, [
        {
            name: 'webmeet_participant_avatar_update',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a', avatar: { enabled: true } }
        },
        {
            name: 'webmeet_chat_send',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', message: 'hello' }
        },
        {
            name: 'webmeet_room_leave',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' }
        }
    ]);
});

test('WebMeetRoom selects the same room action interface for guest and authenticated shells', async () => {
    const authenticatedCalls = [];
    const authenticatedRoom = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'room_00000000-0000-4000-8000-000000000001' },
            participantIdentity: 'participant-auth'
        }),
        runTool: async (name, args) => {
            authenticatedCalls.push({ name, args });
            return { ok: true };
        }
    }));

    await authenticatedRoom.publishAvatar({ enabled: true });

    const guestCalls = [];
    const guestRoom = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'room_00000000-0000-4000-8000-000000000001' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => true,
        runTool: async (name, args) => {
            guestCalls.push({ name, args });
            return { ok: true };
        }
    }));

    await guestRoom.publishAvatar({ enabled: true });

    assert.deepEqual(authenticatedCalls, [{
        name: 'webmeet_participant_avatar_update',
        args: {
            roomId: 'room_00000000-0000-4000-8000-000000000001',
            participantId: 'participant-auth',
            avatar: { enabled: true }
        }
    }]);
    assert.deepEqual(guestCalls, [{
        name: 'webmeet_participant_avatar_update',
        args: {
            roomId: 'room_00000000-0000-4000-8000-000000000001',
            participantId: 'participant-guest',
            avatar: { enabled: true }
        }
    }]);
});

test('WebMeetRoom resolves guest room API from the current session state for avatar updates', async () => {
    let guest = false;
    const guestCalls = [];
    const room = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'room_00000000-0000-4000-8000-000000000001' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => guest,
        runTool: async (name, args) => {
            guestCalls.push({ name, args });
            return { ok: true };
        }
    }));

    guest = true;
    await room.publishAvatar({ enabled: true });

    assert.deepEqual(guestCalls, [{
        name: 'webmeet_participant_avatar_update',
        args: {
            roomId: 'room_00000000-0000-4000-8000-000000000001',
            participantId: 'participant-guest',
            avatar: { enabled: true }
        }
    }]);
});

test('WebMeetRoom owns join, connectLiveKit, leave and session mutation', async () => {
    const calls = [];
    let session = null;
    const room = new WebMeetRoom(createRoomOptions({
        getSession: () => session,
        setSession: (nextSession) => {
            session = nextSession;
        },
        connectLiveKit: async () => {
            calls.push({ name: 'connectLiveKit' });
        },
        disconnectLiveKit: async () => {
            calls.push({ name: 'disconnectLiveKit' });
        },
        runTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'webmeet_room_join') {
                return {
                    meeting: { id: args.roomId },
                    participantIdentity: args.participantId
                };
            }
            return { ok: true };
        }
    }));

    await room.join({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' });
    await room.connectLiveKit();
    await room.leave();

    assert.equal(session, null);
    assert.deepEqual(calls, [
        {
            name: 'webmeet_room_join',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' }
        },
        { name: 'connectLiveKit' },
        { name: 'disconnectLiveKit' },
        {
            name: 'webmeet_room_leave',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' }
        }
    ]);
});

test('WebMeet avatar fallback profile responses render as initials, not generated room avatars', async () => {
    const room = new WebMeetRoom(createRoomOptions());
    const sourceAvatar = buildWebMeetAvatarSource({
        profileAvatar: {
            enabled: true,
            source: { kind: 'fallback' },
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                style: 'robot-soft',
                size: '72'
            }
        },
        override: null,
        userId: 'local:admin',
        participantId: 'participant-a'
    });
    const projection = room.buildAvatarProjection(sourceAvatar, 'participant-a');

    assert.equal(sourceAvatar, null);
    assert.deepEqual(projection, {
        enabled: false,
        config: null,
        fallbackLetter: ''
    });
});

test('room API factory keeps guest and authenticated transport selection explicit', () => {
    assert.ok(createWebMeetRoomApi({
        guest: true,
        runTool: async () => ({})
    }) instanceof GuestWebMeetRoomApi);
    assert.ok(createWebMeetRoomApi({
        guest: false,
        runTool: async () => ({})
    }) instanceof AuthenticatedWebMeetRoomApi);
});

test('room API rejects missing required fields instead of silently no-oping', async () => {
    const authenticatedApi = new AuthenticatedWebMeetRoomApi({
        runTool: async () => {
            throw new Error('runTool should not be called');
        }
    });
    await assert.rejects(
        () => authenticatedApi.sendChat({ roomId: 'room_00000000-0000-4000-8000-000000000001', message: '' }),
        /Missing WebMeet room field: message/
    );
    await assert.rejects(
        () => authenticatedApi.publishAvatar({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a', avatar: null }),
        /Missing WebMeet room field: avatar/
    );

    const guestApi = new GuestWebMeetRoomApi({
        runTool: async () => {
            throw new Error('runTool should not be called');
        }
    });
    await assert.rejects(
        () => guestApi.loadRoomState({ meetingId: '' }),
        /Missing WebMeet room field: roomId/
    );
});

test('WebMeetRoom rejects missing session fields instead of returning empty fallbacks', async () => {
    const room = new WebMeetRoom(createRoomOptions({
        getSession: () => null,
        runTool: async () => {
            throw new Error('runTool should not be called');
        }
    }));

    await assert.rejects(
        () => room.leaveCurrentSession(),
        /Missing WebMeet room field: meetingId/
    );
    await assert.rejects(
        () => room.publishAvatar({ enabled: true }),
        /Missing WebMeet room field: meetingId/
    );
    await assert.rejects(
        () => room.sendChat('', 'hello'),
        /Missing WebMeet room field: meetingId/
    );
    await assert.rejects(
        () => room.loadGuestRoomState(''),
        /Missing WebMeet room field: meetingId/
    );
});

test('WebMeetRoom rejects LiveKit participant events forged for another sender', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        roomId: 'room_00000000-0000-4000-8000-000000000001',
        participantId: 'participant-b',
        profileAvatar: { enabled: true }
    });

    assert.throws(
        () => room.handleIncomingEvent('livekit', encoded, { participantId: 'participant-a' }),
        /mismatched sender/
    );
});

test('WebMeetRoom rejects LiveKit chat events forged for another author', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.CHAT_REALTIME, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        roomId: 'room_00000000-0000-4000-8000-000000000001',
        message: {
            authorId: 'participant-b',
            authorName: 'Participant B',
            message: 'spoofed'
        }
    });

    assert.throws(
        () => room.handleIncomingEvent('livekit', encoded, { participantId: 'participant-a' }),
        /mismatched sender/
    );
});
