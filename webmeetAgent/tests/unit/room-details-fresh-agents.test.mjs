import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';

import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS, directUserAuth, directUserEnvelope } from './verified-grant-fixture.mjs';
import { parseWebMeetEvent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { dashboardDataMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-data-methods.js';

// RS1: the roster room_get (includeParticipants) carries the same post-reconcile
// agents that the later summary room_get returned, so the browser can reuse it
// on leave. Real store, LiveKit stubbed to report an empty room after the leave.

const MASTER_KEY = '0123456789abcdef0123456789abcdef';
const EXTERNAL_AGENT = Object.freeze({
    id: 'agent_external_1',
    agentType: 'external_agent',
    mode: 'listen',
    participantIdentity: 'agent-external-1',
    status: 'active',
    deletedAt: null
});

async function storeFixture(t) {
    const previous = {
        WEBMEET_DATA_DIR: process.env.WEBMEET_DATA_DIR,
        PLOINKY_WEBMEET_MASTER_KEY: process.env.PLOINKY_WEBMEET_MASTER_KEY
    };
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-fresh-agents-'));
    process.env.WEBMEET_DATA_DIR = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = MASTER_KEY;
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.rm(root, { recursive: true, force: true });
    });
    const store = await import('../../lib/webmeetStore.mjs');
    const { handleWebMeetToolCall } = await import('../../tools/webmeet_tool.mjs');
    const createContext = async () => {
        const context = installEdgeJoinFixture(await store.createStoreContext(root));
        context.listLiveKitParticipants = async () => [];
        return context;
    };
    // One tool call as a spawned process or warm worker runs it.
    const call = async (principal, tool, input) => {
        const chunks = [];
        const stdout = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
        await handleWebMeetToolCall({ toolName: tool, envelope: await directUserEnvelope({ ...principal, tool, input }), stdout, createContext });
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    };
    return { root, store, context: await createContext(), call };
}

// A room with the leaving user, one stale stored member and an active
// non-RoboTeam agent (RoboTeam agents are never detached on an empty room).
async function leaveScenario(fixture, title) {
    const admin = await directUserAuth(PRINCIPALS.admin);
    const room = await fixture.store.createMeeting(fixture.context, { title, roomType: 'team', authInfo: admin });
    await fixture.call(PRINCIPALS.explorerUser, 'webmeet_room_join', { roomId: room.id, participantId: 'p-leaver', displayName: 'Leaver' });
    const { mutateRoom } = await import('../../lib/store/roomRecords.mjs');
    const past = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    await mutateRoom(fixture.context, room.id, (_record, payload) => {
        payload.members.push({ id: 'p-stale', displayName: 'Stale', joinedAt: past, lastSeenAt: past });
        payload.agents.push({ ...EXTERNAL_AGENT });
    });
    return room;
}

const externalAgent = (details) => details.agents.find((agent) => agent.id === EXTERNAL_AGENT.id);

// The room-list roster the dashboard derives from a roster snapshot.
async function rosterFromSnapshot(roomId, snapshot) {
    const controller = {
        ...dashboardDataMethods,
        state: { meetings: [{ id: roomId }], meetingParticipantsById: {}, selectedMeetingId: '', session: null },
        webMeetRoom: { disposed: false },
        room: null,
        isGuestSession: () => false,
        fetchMeetingSnapshot: async () => snapshot
    };
    await controller.loadParticipantsForMeetings();
    return controller.state.meetingParticipantsById[roomId];
}

test('RS1: the roster room_get returns agents detached by its own empty-room reconcile', async (t) => {
    const fixture = await storeFixture(t);
    const room = await leaveScenario(fixture, 'Roster room');
    const left = await fixture.call(PRINCIPALS.explorerUser, 'webmeet_room_leave', { roomId: room.id, participantId: 'p-leaver' });
    assert.equal(left.removed, true);
    assert.deepEqual(left.detachedAgents, [], 'the stale member still counts at leave time');
    const roster = await fixture.call(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id, includeParticipants: true });
    assert.deepEqual(roster.participants.filter((entry) => entry.kind !== 'agent'), []);
    assert.equal(externalAgent(roster).status, 'detached');
    assert.ok(externalAgent(roster).deletedAt);
    // I-2: the room-list roster drops the detached agent in this same refresh.
    const listRoster = await rosterFromSnapshot(room.id, roster);
    assert.equal(listRoster.some((entry) => entry.id === EXTERNAL_AGENT.participantIdentity), false);
});

test('RS1: the leave flow ends with the same agents in candidate and base call order', async (t) => {
    const fixture = await storeFixture(t);
    const baseRoom = await leaveScenario(fixture, 'Base order');
    const candidateRoom = await leaveScenario(fixture, 'Candidate order');
    const { listRoomEvents } = await import('../../lib/store/eventLogs.mjs');
    const types = async (room) => (await listRoomEvents(fixture.context, room.id)).map((event) => parseWebMeetEvent(event).type);
    // Only the leave flow's own events are compared; room creation stages
    // several events in the same millisecond, whose file order is not fixed.
    const setupEventCounts = new Map([
        [baseRoom.id, (await types(baseRoom)).length],
        [candidateRoom.id, (await types(candidateRoom)).length]
    ]);
    const flowTypes = async (room) => (await types(room)).slice(setupEventCounts.get(room.id));
    const leaveAndList = async (room) => {
        await fixture.call(PRINCIPALS.explorerUser, 'webmeet_room_leave', { roomId: room.id, participantId: 'p-leaver' });
        await fixture.call(PRINCIPALS.admin, 'webmeet_room_list', {});
    };

    // Base: roster, then a separate summary room_get for the details agents.
    await leaveAndList(baseRoom);
    const baseRoster = await fixture.call(PRINCIPALS.admin, 'webmeet_room_get', { roomId: baseRoom.id, includeParticipants: true });
    const baseDetails = await fixture.call(PRINCIPALS.admin, 'webmeet_room_get', { roomId: baseRoom.id, includeParticipants: false });
    await fixture.call(PRINCIPALS.admin, 'webmeet_chat_list', { roomId: baseRoom.id });
    await fixture.call(PRINCIPALS.admin, 'webmeet_resource_list', { roomId: baseRoom.id });

    // Candidate: the roster snapshot alongside chat and resources; its agents are the details agents.
    await leaveAndList(candidateRoom);
    const [candidateRoster] = await Promise.all([
        fixture.call(PRINCIPALS.admin, 'webmeet_room_get', { roomId: candidateRoom.id, includeParticipants: true }),
        fixture.call(PRINCIPALS.admin, 'webmeet_chat_list', { roomId: candidateRoom.id }),
        fixture.call(PRINCIPALS.admin, 'webmeet_resource_list', { roomId: candidateRoom.id })
    ]);

    const comparable = (agents) => agents.map(({ id, agentType, mode, status, participantIdentity }) => ({ id, agentType, mode, status, participantIdentity }));
    assert.deepEqual(comparable(candidateRoster.agents), comparable(baseDetails.agents));
    assert.equal(externalAgent(baseDetails).status, 'detached');
    assert.equal(externalAgent(candidateRoster).status, 'detached');
    assert.equal(externalAgent(baseRoster).status, 'detached', 'every roster snapshot is post-reconcile');

    // Server-staged events: the same types in the same order for both rooms.
    const baseTypes = await flowTypes(baseRoom);
    assert.deepEqual(baseTypes, ['participant.left', 'participant.left', 'agent.detached']);
    assert.deepEqual(await flowTypes(candidateRoom), baseTypes);
});
