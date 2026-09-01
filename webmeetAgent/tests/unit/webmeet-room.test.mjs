import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AuthenticatedWebMeetRoomApi,
    GuestWebMeetRoomApi,
    createWebMeetRoomApi
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-api.js';
import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js';
import { buildWebMeetAvatarSource } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-avatar-override.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

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
    await api.heartbeat({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' });
    await api.publishAvatar({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a', avatar: { enabled: true } });
    await api.leaveMeeting({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' });

    assert.deepEqual(calls.map((entry) => entry.name), [
        'webmeet_room_join',
        'webmeet_presence_heartbeat',
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
    await api.heartbeat({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' });
    await api.sendChat({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a', message: 'hello' });
    await api.loadRoomState({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' });
    await api.leaveMeeting({ roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' });

    assert.deepEqual(calls, [
        {
            name: 'webmeet_participant_avatar_update',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a', avatar: { enabled: true } }
        },
        {
            name: 'webmeet_presence_heartbeat',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' }
        },
        {
            name: 'webmeet_chat_send_guest',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a', message: 'hello' }
        },
        {
            name: 'webmeet_room_guest_get',
            args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'guest-a' }
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

test('WebMeetRoom forwards the joined guest identity to guest state and chat tools', async () => {
    const calls = [];
    const room = new WebMeetRoom(createRoomOptions({
        getSession: () => ({
            meeting: { id: 'room_00000000-0000-4000-8000-000000000001' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => true,
        runTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'webmeet_room_guest_get') {
                return { meeting: { id: args.roomId }, participants: [], chat: [] };
            }
            return { message: { id: 'message-guest' } };
        }
    }));

    await room.sendChat('', 'hello from guest');
    await room.loadGuestRoomState();
    await room.refreshState();

    assert.deepEqual(calls, [
        {
            name: 'webmeet_chat_send_guest',
            args: {
                roomId: 'room_00000000-0000-4000-8000-000000000001',
                participantId: 'participant-guest',
                message: 'hello from guest'
            }
        },
        {
            name: 'webmeet_room_guest_get',
            args: {
                roomId: 'room_00000000-0000-4000-8000-000000000001',
                participantId: 'participant-guest'
            }
        },
        {
            name: 'webmeet_room_guest_get',
            args: {
                roomId: 'room_00000000-0000-4000-8000-000000000001',
                participantId: 'participant-guest'
            }
        }
    ]);
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

test('WebMeetRoom heartbeats the joined participant while LiveKit is connected', async () => {
    const calls = [];
    const room = new WebMeetRoom(createRoomOptions({
        runTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    }));
    await room.connectLiveKit();
    await room.sendPresenceHeartbeat();
    await room.disconnectLiveKit();
    assert.deepEqual(calls, [{
        name: 'webmeet_presence_heartbeat',
        args: { roomId: 'room_00000000-0000-4000-8000-000000000001', participantId: 'participant-a' },
    }]);
});

test('WebMeetRoom stops heartbeats after an external LiveKit disconnect', async () => {
    const calls = [];
    const room = new WebMeetRoom(createRoomOptions({
        runTool: async (name, args) => { calls.push({ name, args }); return { ok: true }; },
    }));
    await room.connectLiveKit();
    assert.notEqual(room.presenceHeartbeatTimer, null);

    room.handleExternalLiveKitDisconnect();

    assert.equal(room.presenceHeartbeatTimer, null);
    assert.equal(room.getState().livekitState, 'disconnected');
    assert.equal(await room.sendPresenceHeartbeat(), null);
    assert.deepEqual(calls, []);
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
    await assert.rejects(
        () => guestApi.sendChat({ meetingId: 'room_00000000-0000-4000-8000-000000000001', message: 'hello' }),
        /Missing WebMeet room field: participantId/
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

test('WebMeetRoom keeps avatar projection published when LiveKit metadata update times out', async () => {
    const realtimePayloads = [];
    const applied = [];
    const room = new WebMeetRoom(createRoomOptions({
        getCurrentActorId: () => 'user-a',
        getRoom: () => ({
            localParticipant: {
                attributes: {},
                setAttributes: async () => {
                    throw new Error('Request to update local metadata timed out');
                }
            }
        }),
        applyRealtimeParticipantAvatar: (payload) => applied.push(payload),
        publishRealtimePayload: async (payload) => realtimePayloads.push(payload)
    }));

    await room.publishAvatarProjection({
        enabled: true,
        config: { agentId: 'profile:user-a', style: 'pixel' },
        fallbackLetter: 'A'
    }, {
        user: { id: 'user-a' }
    });

    assert.equal(applied.length, 1);
    assert.equal(realtimePayloads.length, 1);
    const parsed = room.eventCodec.parse(realtimePayloads[0]);
    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED);
    assert.equal(parsed.payload.profileAvatar.config.style, 'pixel');
});

test('WebMeetRoom publishes automatic avatar state through the existing realtime projection only', async () => {
    const realtimePayloads = [];
    const applied = [];
    const roomAvatars = {
        'participant-a': {
            enabled: true,
            config: {
                agentId: 'profile:user-a',
                emotion: 'neutral',
                expressionMode: 'audio'
            },
            fallbackLetter: 'A'
        }
    };
    let attributeUpdates = 0;
    let publishedAttributes = null;
    const room = new WebMeetRoom(createRoomOptions({
        getCurrentActorId: () => 'user-a',
        getRoomAvatars: () => roomAvatars,
        setRoomAvatar: (participantId, avatar) => {
            roomAvatars[participantId] = avatar;
        },
        getRoom: () => ({
            localParticipant: {
                attributes: {},
                setAttributes: async (attributes) => {
                    attributeUpdates += 1;
                    publishedAttributes = attributes;
                }
            }
        }),
        applyRealtimeParticipantAvatar: (payload) => applied.push(payload),
        publishRealtimePayload: async (payload) => realtimePayloads.push(payload)
    }));

    await room.publishAvatarRuntimeState({
        emotion: 'happy',
        intensity: 0.7,
        speaking: true,
        confidence: 0.91,
        samples: [1, 2, 3]
    });

    assert.equal(attributeUpdates, 0);
    assert.equal(applied.length, 1);
    assert.equal(realtimePayloads.length, 1);
    const parsed = room.eventCodec.parse(realtimePayloads[0]);
    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_PROJECTED);
    assert.deepEqual(parsed.payload.profileAvatar.runtimeState, {
        emotion: 'happy',
        intensity: 0.7,
        speaking: true
    });
    assert.equal(parsed.payload.profileAvatar.config.expressionMode, 'audio');
    assert.equal('confidence' in parsed.payload.profileAvatar.runtimeState, false);
    assert.equal('samples' in parsed.payload.profileAvatar.runtimeState, false);
    assert.equal(Number.isSafeInteger(parsed.payload.sequence), true);
    const firstProjectionSequence = parsed.payload.sequence;

    await room.publishAvatarProjection({
        enabled: true,
        config: {
            agentId: 'profile:user-a',
            emotion: 'neutral',
            expressionMode: 'audio'
        },
        fallbackLetter: 'A'
    }, { user: { id: 'user-a' } });

    assert.equal(attributeUpdates, 1);
    assert.equal('runtimeState' in JSON.parse(publishedAttributes.webmeetProfileAvatar), false);
    const republished = room.eventCodec.parse(realtimePayloads.at(-1));
    assert.equal(republished.payload.profileAvatar.runtimeState.emotion, 'happy');

    await room.publishAvatarProjection({
        enabled: true,
        config: {
            agentId: 'profile:user-a',
            emotion: 'amused',
            expressionMode: 'manual'
        },
        fallbackLetter: 'A'
    }, { user: { id: 'user-a' } });

    const manualProjection = room.eventCodec.parse(realtimePayloads.at(-1));
    assert.equal('runtimeState' in manualProjection.payload.profileAvatar, false);
    assert.equal(manualProjection.payload.profileAvatar.config.emotion, 'amused');
    assert.equal(manualProjection.payload.sequence, firstProjectionSequence + 2);
});

test('WebMeetRoom coalesces queued automatic avatar states and sequences projections', async () => {
    const realtimePayloads = [];
    const releasePublishes = [];
    const roomAvatars = {
        'participant-a': {
            enabled: true,
            config: { agentId: 'profile:user-a', expressionMode: 'audio' }
        }
    };
    const room = new WebMeetRoom(createRoomOptions({
        getCurrentActorId: () => 'user-a',
        getRoomAvatars: () => roomAvatars,
        setRoomAvatar: (participantId, avatar) => {
            roomAvatars[participantId] = avatar;
        },
        publishRealtimePayload: (payload) => new Promise((resolve) => {
            realtimePayloads.push(payload);
            releasePublishes.push(resolve);
        })
    }));

    const first = room.publishAvatarRuntimeState({ emotion: 'happy', speaking: true, intensity: 0.7 });
    const second = room.publishAvatarRuntimeState({ emotion: 'alert', speaking: true, intensity: 0.8 });
    const third = room.publishAvatarRuntimeState({ emotion: 'confused', speaking: true, intensity: 0.6 });

    assert.equal(realtimePayloads.length, 1);
    releasePublishes[0]();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(realtimePayloads.length, 2);
    releasePublishes[1]();
    await Promise.all([first, second, third]);

    const parsed = realtimePayloads.map((payload) => room.eventCodec.parse(payload).payload);
    assert.equal(parsed[1].sequence, parsed[0].sequence + 1);
    assert.deepEqual(parsed.map((payload) => payload.profileAvatar.runtimeState.emotion), ['happy', 'confused']);
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

test('WebMeetRoom rejects blackboard command status forged for another participant', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        boardId: 'agent:agent_robo_team',
        commandId: 'command-1',
        participantId: 'participant-b',
        state: 'started'
    });

    assert.throws(
        () => room.handleIncomingEvent('livekit', encoded, { participantId: 'participant-a' }),
        /mismatched sender/
    );
});

test('WebMeetRoom rejects SCRIPTA drafts forged for another editor', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        boardId: 'agent:agent_robo_team',
        blackboardRevision: 3,
        changeType: 'scripta-p-variant-edit-draft',
        editorParticipantId: 'participant-b',
    });

    assert.throws(
        () => room.handleIncomingEvent('livekit', encoded, { participantId: 'participant-a' }),
        /mismatched editor/
    );
});

test('WebMeetRoom accepts server-authored Blackboard refreshes without a participant sender', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        boardId: 'board-notes',
        blackboardRevision: 12,
        changeType: 'update',
        reason: 'meeting_notes_revision',
    });

    assert.doesNotThrow(() => room.handleIncomingEvent('livekit', encoded, {}));
});

test('WebMeetRoom accepts server-authored Meeting Notes activity without a participant sender', () => {
    const room = new WebMeetRoom(createRoomOptions());
    const encoded = buildWebMeetEvent('room_00000000-0000-4000-8000-000000000001', WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY, {
        meetingId: 'room_00000000-0000-4000-8000-000000000001',
        phase: 'analyzing',
        pendingSegmentCount: 2,
        analysisRevision: 3,
    });

    assert.doesNotThrow(() => room.handleIncomingEvent('livekit', encoded, {}));
});
