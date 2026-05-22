import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    AuthenticatedWebMeetRoomApi,
    GuestWebMeetRoomApi,
    createWebMeetRoomApi
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-api.js';
import { WebMeetRoomRuntime } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-runtime.js';

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

test('room runtime selects the same room action interface for guest and authenticated shells', async () => {
    const authenticatedCalls = [];
    const authenticatedRuntime = new WebMeetRoomRuntime({
        getSession: () => ({
            meeting: { id: 'meeting-1' },
            participantIdentity: 'participant-auth'
        }),
        isGuestSession: () => false,
        runTool: async (name, args) => {
            authenticatedCalls.push({ name, args });
            return { ok: true };
        }
    });

    await authenticatedRuntime.publishAvatar({ enabled: true });

    const guestCalls = [];
    const guestRuntime = new WebMeetRoomRuntime({
        getSession: () => ({
            meeting: { id: 'meeting-1' },
            participantIdentity: 'participant-guest'
        }),
        isGuestSession: () => true,
        callPublicGuestApi: async (meetingId, action, payload) => {
            guestCalls.push({ meetingId, action, payload });
            return { ok: true };
        }
    });

    await guestRuntime.publishAvatar({ enabled: true });

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

test('room API factory keeps guest and authenticated transport selection explicit', () => {
    assert.ok(createWebMeetRoomApi({ guest: true }) instanceof GuestWebMeetRoomApi);
    assert.ok(createWebMeetRoomApi({ guest: false }) instanceof AuthenticatedWebMeetRoomApi);
});
