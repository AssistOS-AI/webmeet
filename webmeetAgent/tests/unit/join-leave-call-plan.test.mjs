import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dashboardDataMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js';
import { dashboardSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js';
import { meetingActionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/meeting-action-methods.js';
import { WebMeetRoom } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room.js';
import { ROOM_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js';
import { runWebMeetTool } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-api-client.js';

// Pins the browser MCP call plan of a dashboard join and leave: which calls are
// issued, in which parallel tiers, and the resulting UI state and room events.
// Every tool call resolves after TOOL_DELAY_MS, so calls issued together start
// within a few milliseconds and a dependent call starts at least one delay later.

const TOOL_DELAY_MS = 50;
const SAME_TIER_MS = 5;
const ROOM_A = 'room_00000000-0000-4000-8000-00000000000a';
const ROOM_B = 'room_00000000-0000-4000-8000-00000000000b';
const PARTICIPANT_ID = 'participant-fixed';
const AGENT = Object.freeze({
    id: 'agent-x',
    participantIdentity: 'agent-x',
    agentType: 'external_agent',
    mode: 'listen',
    status: 'active',
    deletedAt: null
});

function meetingView(id) {
    return { id, roomId: id, title: `Room ${id.slice(-1)}`, name: `Room ${id.slice(-1)}`, roomType: 'team', status: 'active' };
}

function defaultResponse(name, args) {
    switch (name) {
    case 'webmeet_room_list':
        return { rooms: [meetingView(ROOM_A), meetingView(ROOM_B)], canManageRooms: true };
    case 'webmeet_room_get':
        return {
            meeting: meetingView(args.roomId),
            participants: args.includeParticipants ? [{ id: `other-${args.roomId.slice(-1)}`, displayName: 'Other' }] : [],
            meetingNotes: { enabled: false },
            agents: [{ ...AGENT }]
        };
    case 'webmeet_chat_list':
        return { messages: [{ id: `chat-${args.roomId.slice(-1)}`, text: 'hello' }] };
    case 'webmeet_resource_list':
        return { resources: [{ id: `resource-${args.roomId.slice(-1)}` }] };
    case 'webmeet_room_join':
        return {
            meeting: meetingView(args.roomId),
            participant: { id: args.participantId, displayName: args.displayName || 'Member' },
            participantIdentity: args.participantId,
            participantToken: 'token',
            livekitUrl: 'wss://livekit.test/',
            roomName: `webmeet-${args.roomId}`
        };
    case 'webmeet_room_leave':
        return { ok: true, removed: true, participantId: args.participantId, detachedAgents: [] };
    case 'webmeet_participant_avatar_update':
        return { ok: true, participantId: args.participantId, profileAvatar: { enabled: false } };
    case 'webmeet_room_create':
        return { id: ROOM_B, roomId: ROOM_B, title: 'Room b' };
    case 'webmeet_room_archive':
        return { ok: true };
    case 'webmeet_robo_team_get':
        return { settings: { meetingNotes: { enabled: false } } };
    default:
        throw new Error(`unexpected tool ${name}`);
    }
}

function installHarness(t, { failure = null } = {}) {
    const previous = { window: globalThis.window, assistOS: globalThis.assistOS };
    const started = performance.now();
    const calls = [];
    const log = [];
    const client = {
        async callTool(name, args) {
            const entry = { name, args, at: performance.now() - started };
            calls.push(entry);
            log.push(`tool:${name}${name === 'webmeet_room_get' ? `:${args.includeParticipants ? 'participants' : 'summary'}` : ''}`);
            await new Promise((resolve) => setTimeout(resolve, TOOL_DELAY_MS));
            const message = failure?.(name, args);
            if (message) return { isError: true, content: [{ type: 'text', text: message }] };
            return { content: [{ type: 'text', text: JSON.stringify(defaultResponse(name, args)) }] };
        }
    };
    globalThis.window = {
        webSkel: { appServices: { getClient: () => client } },
        setTimeout,
        clearTimeout,
        confirm: () => true,
        assistOS: { user: { email: 'member@example.test' } }
    };
    globalThis.assistOS = {
        UI: {
            async showModal(name) {
                if (name === 'create-room-modal') return { roomTitle: 'Room b', roomType: 'team' };
                if (name === 'webmeet-room-settings-modal') return { archive: true };
                return null;
            }
        }
    };
    const controller = createController(log);
    t.after(() => {
        controller.webMeetRoom.dispose();
        globalThis.window = previous.window;
        if (previous.assistOS === undefined) delete globalThis.assistOS;
        else globalThis.assistOS = previous.assistOS;
    });
    return { controller, calls, log };
}

function createController(log) {
    const controller = Object.assign({}, dashboardDataMethods, dashboardSessionMethods, meetingActionMethods, {
        state: {
            meetings: [meetingView(ROOM_A), meetingView(ROOM_B)],
            selectedMeetingId: '',
            meetingParticipantsById: {},
            participants: [],
            chat: [],
            resources: [],
            agents: [],
            session: null,
            roomState: '',
            canManageRooms: true,
            joiningMeetingId: '',
            leavingMeeting: false,
            media: { microphone: false, camera: false },
            mediaSettings: {}
        },
        meetingDetailsLoadSeq: 0,
        meetingListLoadSeq: 0,
        cachedStableParticipantId: PARTICIPANT_ID,
        currentActor: { id: 'member-1' },
        room: null,
        errors: [],
        roomLiveKit: { ensureLiveKitClient: async () => { log.push('sdk:load'); return {}; } },
        meetingListController: {
            removeParticipantFromMeetingMap(map, meetingId, participantId) {
                if (Array.isArray(map?.[meetingId])) map[meetingId] = map[meetingId].filter((entry) => entry.id !== participantId);
            }
        },
        renderAll() {},
        renderMeetingList() {},
        renderMeetingSummary() {},
        setMobilePanel() {},
        clearRoomTransitionMessage() {},
        setConnectingRoomTransition() {},
        setDisconnectingRoomTransition() {},
        loadParticipantAudioSettings() {},
        syncParticipantsFromRoom() {},
        getMeetingTitleById: () => 'Room',
        setError(message) { this.errors.push(message); },
        startWorkspaceEvents() { log.push('workspace-events:start'); },
        stopWorkspaceEvents() { log.push('workspace-events:stop'); },
        primeCurrentParticipantAvatarProjection: async () => null,
        restorePersistedMediaState: async () => {},
        async publishCurrentParticipantAvatar() {
            return await this.webMeetRoom.publishAvatar({ enabled: false });
        },
        async connectRoom() { log.push('livekit:connect'); },
        async disconnectRoom() { log.push('livekit:disconnect'); }
    });
    Object.defineProperty(controller, 'selectedMeeting', {
        get() { return this.state.meetings.find((entry) => entry.id === this.state.selectedMeetingId) || null; }
    });
    controller.webMeetRoom = new WebMeetRoom({
        getSession: () => controller.state.session,
        setSession: (session) => { controller.state.session = session; },
        isGuestSession: () => controller.isGuestSession(),
        getSelectedWorkspaceId: () => 'webmeet-rooms',
        connectLiveKit: (transition) => controller.connectRoom(transition),
        disconnectLiveKit: (options) => controller.disconnectRoom(options),
        runTool: runWebMeetTool,
        getRoom: () => controller.room,
        getRoomAvatars: () => ({}),
        setRoomAvatar() {},
        applyRealtimeParticipantAvatar() {},
        publishRealtimePayload: async () => {},
        getCurrentActorId: () => 'member-1'
    });
    for (const type of Object.values(ROOM_EVENT_TYPES)) {
        controller.webMeetRoom.addEventListener(type, () => log.push(`event:${type}`));
    }
    return controller;
}

function finalState(controller) {
    const { meetings, meetingParticipantsById, participants, agents, chat, resources, session, selectedMeetingId, roomState } = controller.state;
    return structuredClone({ meetings, meetingParticipantsById, participants, agents, chat, resources, session, selectedMeetingId, roomState });
}

// Groups calls into tiers: a call starting within SAME_TIER_MS of the tier's
// first call belongs to it.
function tiers(calls) {
    const groups = [];
    for (const call of calls) {
        const label = call.name === 'webmeet_room_get'
            ? `room_get:${call.args.includeParticipants ? 'participants' : 'summary'}`
            : call.name.replace(/^webmeet_/, '');
        const group = groups.at(-1);
        if (group && call.at - group.at <= SAME_TIER_MS) group.calls.push(label);
        else groups.push({ at: call.at, calls: [label] });
    }
    return groups.map((group) => ({ ...group, calls: group.calls.sort() }));
}

async function joinRoomA(controller) {
    await controller.selectAndJoinMeeting({ dataset: { id: ROOM_A } });
}

async function joinedHarness(t, options) {
    const harness = installHarness(t, options);
    await joinRoomA(harness.controller);
    harness.calls.length = 0;
    harness.log.length = 0;
    harness.controller.clearMeetingGetCache();
    return harness;
}

const JOINED_SESSION = {
    meeting: meetingView(ROOM_A),
    participant: { id: PARTICIPANT_ID, displayName: 'Member' },
    participantIdentity: PARTICIPANT_ID,
    participantToken: 'token',
    livekitUrl: 'wss://livekit.test/',
    roomName: `webmeet-${ROOM_A}`
};

test('C1/C6: join issues details, chat and resources in one tier, then room_join, then connects LiveKit once', async (t) => {
    const { controller, calls, log } = installHarness(t);
    await joinRoomA(controller);
    const plan = tiers(calls);
    assert.deepEqual(plan[0].calls, ['chat_list', 'resource_list', 'room_get:summary'], 'one tier before room_join');
    assert.deepEqual(plan[1].calls, ['room_join']);
    assert.ok(plan[1].at - plan[0].at >= TOOL_DELAY_MS - 1, 'room_join waits for the details tier');
    const joinIndex = log.indexOf('tool:webmeet_room_join');
    assert.equal(log.filter((entry) => entry === 'livekit:connect').length, 1);
    assert.ok(log.indexOf('livekit:connect') > joinIndex, 'LiveKit connects after room_join');
    assert.ok(log.indexOf('sdk:load') !== -1 && log.indexOf('sdk:load') < joinIndex, 'the LiveKit SDK load starts before room_join');
});

test('C4/C5: join leaves the same UI state and dispatches the same room events', async (t) => {
    const { controller, log } = installHarness(t);
    await joinRoomA(controller);
    assert.deepEqual(log.filter((entry) => entry.startsWith('event:')), ['event:room:joined']);
    assert.deepEqual(log.filter((entry) => entry.startsWith('tool:')).sort(), [
        'tool:webmeet_chat_list',
        'tool:webmeet_participant_avatar_update',
        'tool:webmeet_resource_list',
        'tool:webmeet_room_get:summary',
        'tool:webmeet_room_get:summary',
        'tool:webmeet_room_join'
    ]);
    assert.deepEqual(finalState(controller), {
        meetings: [meetingView(ROOM_A), meetingView(ROOM_B)],
        meetingParticipantsById: {},
        participants: [],
        agents: [{ ...AGENT }],
        chat: [{ id: 'chat-a', text: 'hello' }],
        resources: [{ id: 'resource-a' }],
        session: JOINED_SESSION,
        selectedMeetingId: ROOM_A,
        roomState: ''
    });
});

test('C2/C6: leave disconnects first, then room_leave, room_list, and one tier of rosters, chat and resources', async (t) => {
    const { controller, calls, log } = await joinedHarness(t);
    // A warm cache entry must not replace the roster whose agents are reused.
    controller.meetingGetCache.set(`${ROOM_A}:participants`, {
        value: { ...defaultResponse('webmeet_room_get', { roomId: ROOM_A, includeParticipants: true }), agents: [] },
        timestamp: Date.now(),
        promise: null
    });
    await controller.leaveMeeting();
    const plan = tiers(calls);
    assert.deepEqual(plan.map((tier) => tier.calls), [
        ['room_leave'],
        ['room_list'],
        ['chat_list', 'resource_list', 'room_get:participants', 'room_get:participants']
    ]);
    assert.equal(calls.length, 6);
    assert.equal(calls.filter((call) => call.name === 'webmeet_room_get' && call.args.includeParticipants !== true).length, 0);
    assert.ok(log.indexOf('livekit:disconnect') < log.indexOf('tool:webmeet_room_leave'), 'LiveKit disconnects before room_leave');
    assert.equal(controller.state.agents.length, 1, 'details reuse the fresh roster, not the warm cache entry');
});

test('C2: with one visible room, leave makes five calls in three tiers', async (t) => {
    const { controller, calls } = await joinedHarness(t);
    controller.state.meetings = [meetingView(ROOM_A)];
    controller.state.meetingParticipantsById = {};
    const original = globalThis.window.webSkel.appServices.getClient;
    globalThis.window.webSkel.appServices.getClient = () => {
        const client = original();
        return {
            async callTool(name, args) {
                const result = await client.callTool(name, args);
                if (name !== 'webmeet_room_list') return result;
                return { content: [{ type: 'text', text: JSON.stringify({ rooms: [meetingView(ROOM_A)], canManageRooms: true }) }] };
            }
        };
    };
    await controller.leaveMeeting();
    assert.deepEqual(tiers(calls).map((tier) => tier.calls), [
        ['room_leave'],
        ['room_list'],
        ['chat_list', 'resource_list', 'room_get:participants']
    ]);
    assert.equal(calls.length, 5);
});

test('C4/C5: leave leaves the same UI state, room events and restarts workspace events', async (t) => {
    const { controller, log } = await joinedHarness(t);
    await controller.leaveMeeting();
    assert.deepEqual(log.filter((entry) => entry.startsWith('event:')), []);
    assert.equal(log.at(-1), 'workspace-events:start');
    assert.deepEqual(finalState(controller), {
        meetings: [meetingView(ROOM_A), meetingView(ROOM_B)],
        meetingParticipantsById: {
            [ROOM_A]: [
                { id: 'other-a', name: 'Other', micOn: false, isAgent: false },
                { id: 'agent-x', name: 'external_agent (AI)', micOn: false, isAgent: true }
            ],
            [ROOM_B]: [
                { id: 'other-b', name: 'Other', micOn: false, isAgent: false },
                { id: 'agent-x', name: 'external_agent (AI)', micOn: false, isAgent: true }
            ]
        },
        participants: [],
        agents: [{ ...AGENT }],
        chat: [{ id: 'chat-a', text: 'hello' }],
        resources: [{ id: 'resource-a' }],
        session: null,
        selectedMeetingId: ROOM_A,
        roomState: 'Disconnecting'
    });
    assert.deepEqual(controller.errors, []);
});

test('C4: a non-manager leave loads chat with the roster tier and keeps agents empty', async (t) => {
    const { controller, calls } = await joinedHarness(t);
    controller.state.canManageRooms = false;
    const original = globalThis.window.webSkel.appServices.getClient;
    globalThis.window.webSkel.appServices.getClient = () => {
        const client = original();
        return {
            async callTool(name, args) {
                const result = await client.callTool(name, args);
                if (name !== 'webmeet_room_list') return result;
                return { content: [{ type: 'text', text: JSON.stringify({ rooms: [meetingView(ROOM_A)], canManageRooms: false }) }] };
            }
        };
    };
    await controller.leaveMeeting();
    assert.deepEqual(tiers(calls).map((tier) => tier.calls), [
        ['room_leave'],
        ['room_list'],
        ['chat_list', 'room_get:participants']
    ]);
    assert.deepEqual(controller.state.agents, []);
    assert.deepEqual(controller.state.chat, [{ id: 'chat-a', text: 'hello' }]);
});

test('C4: a deleted selected room found by the roster pass clears the selection without a details error', async (t) => {
    const { controller, calls } = await joinedHarness(t);
    const original = globalThis.window.webSkel.appServices.getClient;
    globalThis.window.webSkel.appServices.getClient = () => {
        const client = original();
        return {
            async callTool(name, args) {
                await client.callTool(name, args);
                if (args?.roomId === ROOM_A && name !== 'webmeet_room_leave') {
                    return { isError: true, content: [{ type: 'text', text: 'Meeting not found.' }] };
                }
                return { content: [{ type: 'text', text: JSON.stringify(defaultResponse(name, args)) }] };
            }
        };
    };
    await controller.leaveMeeting();
    assert.equal(calls.filter((call) => call.name === 'webmeet_room_list').length, 1, 'no extra directory refresh');
    assert.deepEqual(controller.errors, []);
    assert.equal(controller.state.selectedMeetingId, '');
    assert.deepEqual(controller.state.meetings, [meetingView(ROOM_B)]);
    assert.deepEqual(controller.state.chat, []);
    assert.deepEqual(controller.state.resources, []);
    assert.deepEqual(controller.state.agents, []);
});

const rosterFailure = (name, args) => (
    name === 'webmeet_room_get' && args.includeParticipants === true && args.roomId === ROOM_A
        ? 'LiveKit request failed: ListParticipants'
        : ''
);

function assertRosterFailureState(controller, log) {
    assert.deepEqual(controller.state.meetings, [meetingView(ROOM_A), meetingView(ROOM_B)]);
    assert.deepEqual(controller.state.meetingParticipantsById[ROOM_A], []);
    assert.deepEqual(controller.state.agents, [{ ...AGENT }]);
    assert.deepEqual(controller.state.chat, [{ id: 'chat-a', text: 'hello' }]);
    assert.deepEqual(controller.state.resources, [{ id: 'resource-a' }]);
    assert.ok(log.includes('tool:webmeet_room_get:summary'), 'the base summary room_get is issued');
}

test('C7: a failed roster fetch on leave falls back to the summary details and still restarts workspace events', async (t) => {
    const { controller, log } = await joinedHarness(t, { failure: rosterFailure });
    await controller.leaveMeeting();
    assertRosterFailureState(controller, log);
    assert.equal(log.at(-1), 'workspace-events:start');
    assert.deepEqual(controller.errors, []);
});

test('C7: a failed roster fetch after room creation and archive keeps loadMeetings resolving', async (t) => {
    const { controller, log } = installHarness(t, { failure: rosterFailure });
    controller.state.selectedMeetingId = ROOM_A;
    controller.getMeetingFromActionTarget = () => meetingView(ROOM_A);
    controller.buildRoomLink = () => 'https://explorer.test/webmeetAgent/roomLoader.html';
    await controller.openRoomSettings({});
    assert.ok(log.includes('tool:webmeet_room_archive'));
    assertRosterFailureState(controller, log);
    assert.deepEqual(controller.errors, ['Room archived successfully.']);

    log.length = 0;
    controller.state.selectedMeetingId = ROOM_A;
    // createMeeting selects the room it created, whose roster succeeds.
    await controller.createMeeting();
    assert.ok(log.includes('tool:webmeet_room_create'));
    assert.equal(controller.state.selectedMeetingId, ROOM_B);
    assert.deepEqual(controller.state.chat, [{ id: 'chat-b', text: 'hello' }]);
});

test('C7: a failed roster fetch when switching rooms still joins the next room', async (t) => {
    const failure = (name, args) => (
        name === 'webmeet_room_get' && args.includeParticipants === true && args.roomId === ROOM_A
            ? 'Timed out acquiring meeting lock for room_a after 5000ms (no current owner).'
            : ''
    );
    const { controller, log } = await joinedHarness(t, { failure });
    await controller.selectAndJoinMeeting({ dataset: { id: ROOM_B } });
    assert.deepEqual(controller.errors, []);
    assert.equal(controller.state.session?.meeting?.id, ROOM_B);
    assert.ok(log.includes('workspace-events:start'));
    assert.ok(log.indexOf('tool:webmeet_room_leave') < log.lastIndexOf('tool:webmeet_room_join'));
});
