import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AuthenticatedWebMeetRoomApi,
    GuestWebMeetRoomApi,
    createWebMeetRoomApi
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-api.js';
import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

function createRoomOptions(overrides = {}) {
    return {
        getSession: () => ({
            meeting: { id: 'meeting-1' },
            participantIdentity: 'participant-a'
        }),
        setSession: () => {},
        isGuestSession: () => false,
        callPublicGuestApi: async () => ({}),
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

    await api.joinMeeting({ meetingId: 'meeting-1', participantId: 'participant-a' });
    await api.publishAvatar({ meetingId: 'meeting-1', participantId: 'participant-a', avatar: { enabled: true } });
    await api.leaveMeeting({ meetingId: 'meeting-1', participantId: 'participant-a' });

    assert.deepEqual(calls.map((entry) => entry.name), [
        'webmeet_meeting_join',
        'webmeet_participant_avatar_update',
        'webmeet_meeting_leave'
    ]);
});

test('room API routes guest room actions through scoped public guest endpoints', async () => {
    const calls = [];
    const api = new GuestWebMeetRoomApi({
        callPublicGuestApi: async (meetingId, action, payload) => {
            calls.push({ meetingId, action, payload });
            return { ok: true, action };
        }
    });

    await api.publishAvatar({ meetingId: 'meeting-1', participantId: 'guest-a', avatar: { enabled: true } });
    await api.sendChat({ meetingId: 'meeting-1', message: 'hello' });
    await api.presencePing({ meetingId: 'meeting-1', participantId: 'guest-a' });
    await api.leaveMeeting({ meetingId: 'meeting-1', participantId: 'guest-a' });

    assert.deepEqual(calls, [
        { meetingId: 'meeting-1', action: 'guest-avatar', payload: { avatar: { enabled: true } } },
        { meetingId: 'meeting-1', action: 'guest-chat', payload: { message: 'hello' } },
        { meetingId: 'meeting-1', action: 'guest-presence', payload: {} },
        { meetingId: 'meeting-1', action: 'guest-leave', payload: {} }
    ]);
});

test('WebMeetRoom selects the same room action interface for guest and authenticated shells', async () => {
    const authenticatedCalls = [];
    const authenticatedRoom = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'meeting-1' },
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
            meeting: { id: 'meeting-1' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => true,
        callPublicGuestApi: async (meetingId, action, payload) => {
            guestCalls.push({ meetingId, action, payload });
            return { ok: true };
        }
    }));

    await guestRoom.publishAvatar({ enabled: true });

    assert.deepEqual(authenticatedCalls, [{
        name: 'webmeet_participant_avatar_update',
        args: {
            meetingId: 'meeting-1',
            participantId: 'participant-auth',
            avatar: { enabled: true }
        }
    }]);
    assert.deepEqual(guestCalls, [{
        meetingId: 'meeting-1',
        action: 'guest-avatar',
        payload: { avatar: { enabled: true } }
    }]);
});

test('WebMeetRoom resolves guest room API from the current session state for avatar updates', async () => {
    let guest = false;
    const guestCalls = [];
    const authenticatedCalls = [];
    const room = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'meeting-1' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => guest,
        callPublicGuestApi: async (meetingId, action, payload) => {
            guestCalls.push({ meetingId, action, payload });
            return { ok: true };
        },
        runTool: async (name, args) => {
            authenticatedCalls.push({ name, args });
            throw new Error('authenticated WebMeet tools must not be used by guest rooms');
        }
    }));

    guest = true;
    await room.publishAvatar({ enabled: true });

    assert.deepEqual(authenticatedCalls, []);
    assert.deepEqual(guestCalls, [{
        meetingId: 'meeting-1',
        action: 'guest-avatar',
        payload: { avatar: { enabled: true } }
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
            if (name === 'webmeet_meeting_join') {
                return {
                    meeting: { id: args.meetingId },
                    participantIdentity: args.participantId
                };
            }
            return { ok: true };
        }
    }));

    await room.join({ meetingId: 'meeting-1', participantId: 'participant-a' });
    await room.connectLiveKit();
    await room.leave();

    assert.equal(session, null);
    assert.deepEqual(calls, [
        {
            name: 'webmeet_meeting_join',
            args: { meetingId: 'meeting-1', participantId: 'participant-a' }
        },
        { name: 'connectLiveKit' },
        { name: 'disconnectLiveKit' },
        {
            name: 'webmeet_meeting_leave',
            args: { meetingId: 'meeting-1', participantId: 'participant-a' }
        }
    ]);
});

test('room API factory keeps guest and authenticated transport selection explicit', () => {
    assert.ok(createWebMeetRoomApi({
        guest: true,
        callPublicGuestApi: async () => ({})
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
        () => authenticatedApi.sendChat({ meetingId: 'meeting-1', message: '' }),
        /Missing WebMeet room field: message/
    );
    await assert.rejects(
        () => authenticatedApi.publishAvatar({ meetingId: 'meeting-1', participantId: 'participant-a', avatar: null }),
        /Missing WebMeet room field: avatar/
    );

    const guestApi = new GuestWebMeetRoomApi({
        callPublicGuestApi: async () => {
            throw new Error('callPublicGuestApi should not be called');
        }
    });
    await assert.rejects(
        () => guestApi.presencePing({ meetingId: '' }),
        /Missing WebMeet room field: meetingId/
    );
    await assert.rejects(
        () => guestApi.loadRoomState({ meetingId: '' }),
        /Missing WebMeet room field: meetingId/
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
        () => room.presencePing(),
        /Missing WebMeet room field: meetingId/
    );
    await assert.rejects(
        () => room.loadGuestRoomState(''),
        /Missing WebMeet room field: meetingId/
    );
});

test('WebMeetRoom rejects LiveKit participant events forged for another sender', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('meeting-1', WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED, {
        meetingId: 'meeting-1',
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
    const encoded = buildWebMeetEvent('meeting-1', WEBMEET_EVENT_TYPES.CHAT_REALTIME, {
        meetingId: 'meeting-1',
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
