import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    assertMeetingSecretaryAuth,
    hasCompleteMeetingNotesSectionTargets,
    normalizeMeetingNotesDocument,
    publishMeetingNotesBlackboardUpdate,
    resetMeetingNotesForRemovedDocument,
    heartbeatMeetingNotesSession,
    startMeetingNotesSession,
} from '../../lib/meetingNotes/service.mjs';
import { normalizeRoboTeamSettings } from '../../lib/roboTeam/service.mjs';
import {
    createMeeting,
    createStoreContext,
    getMeeting,
    getRoomBlackboard,
    heartbeatMeetingPresence,
    joinMeeting,
    updateRoboTeamSettings,
} from '../../lib/webmeetStore.mjs';
import {
    WEBMEET_EVENT_TYPES,
    parseWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import { resolveMeetingNotesDocumentStatus } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-scripta-rendering.js';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';

test('Meeting Secretary tools reject regular callers', () => {
    assert.throws(() => assertMeetingSecretaryAuth({ user: { id: 'user-1' } }), /Meeting Secretary/);
    assert.throws(() => assertMeetingSecretaryAuth({
        agent: { principalId: 'agent:AnotherRepo/webmeetScribeAgent' },
    }), /Meeting Secretary/);
    assert.throws(() => assertMeetingSecretaryAuth({
        agent: { principalId: 'webmeetScribeAgent' },
    }), /Meeting Secretary/);
    assert.doesNotThrow(() => assertMeetingSecretaryAuth({
        agent: { principalId: 'agent:AchillesIDE/webmeetScribeAgent' },
    }));
});

test('RoboTeam settings tools are exposed through the MCP contract', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const tools = new Map(config.tools.map((entry) => [entry.name, entry]));

    assert.deepEqual(Object.keys(tools.get('webmeet_robo_team_get').inputSchema), ['roomId']);
    assert.deepEqual(Object.keys(tools.get('webmeet_robo_team_update').inputSchema), ['roomId', 'settings']);
    assert.equal(tools.get('webmeet_robo_team_update').inputSchema.settings.type, 'object');
    assert.equal(
        tools.get('webmeet_robo_team_update').inputSchema.settings.properties.meetingNotes
            .properties.enabled.type,
        'boolean',
    );
    assert.equal(
        tools.get('webmeet_robo_team_update').inputSchema.settings.properties.blackboard
            .properties.enabled.type,
        'boolean',
    );
    for (const toolName of [
        'webmeet_scribe_session_start',
        'webmeet_scribe_notes_apply',
        'webmeet_scribe_session_heartbeat',
        'webmeet_scribe_session_finalize',
    ]) {
        assert.deepEqual(tools.get(toolName).tags, ['internal']);
    }
    assert.deepEqual(
        tools.get('webmeet_scribe_session_heartbeat').inputSchema.activity.enum,
        ['listening', 'queued', 'analyzing', 'updating', 'retrying', 'waiting_for_new_speech'],
    );
    assert.equal(
        tools.get('webmeet_scribe_session_heartbeat').inputSchema.includeDocumentSnapshot.type,
        'boolean',
    );
    assert.equal(
        tools.get('webmeet_scribe_session_heartbeat').inputSchema.includeDocumentSnapshot.optional,
        true,
    );
    assert.equal(tools.get('webmeet_scribe_notes_apply').inputSchema.markdown.type, 'string');
    assert.equal(tools.get('webmeet_scribe_notes_apply').inputSchema.markdown.optional, false);
});

test('meeting notes preserve attributed holistic sections', () => {
    const document = normalizeMeetingNotesDocument({
        title: 'Architecture',
        summary: 'A cumulative summary.',
        ideas: [{
            id: 'idea-auth',
            text: '  Use delegated identity. ',
            attributions: [{ participantId: 'p1', displayName: 'Ana' }],
        }],
    });
    assert.equal(document.ideas[0].text, 'Use delegated identity.');
    assert.deepEqual(document.ideas[0].attributions, [{ participantId: 'p1', displayName: 'Ana' }]);
    assert.deepEqual(document.decisions, []);
});

test('meeting notes replace malformed documents that do not expose every section target', () => {
    const complete = Object.fromEntries([
        'summary', 'ideas', 'decisions', 'questions', 'risks', 'actions', 'unresolved',
    ].map((key) => [key, { chapterId: `chapter-${key}`, paragraphId: `paragraph-${key}` }]));
    assert.equal(hasCompleteMeetingNotesSectionTargets({ sectionTargets: complete }), true);
    assert.equal(hasCompleteMeetingNotesSectionTargets({
        sectionTargets: { summary: complete.summary },
    }), false);
});

test('clearing the Meeting Notes board resets the active discussion session', () => {
    const payload = {
        meetingNotes: {
            activeSessionId: 'notes-1',
            documentOrder: ['resource-1'],
            sessions: {
                'notes-1': { sessionId: 'notes-1', status: 'active', boardId: 'board-notes', documentResourceId: 'resource-1' },
            },
        },
        agents: [{ agentType: 'meeting_secretary', status: 'active' }],
    };
    assert.equal(resetMeetingNotesForRemovedDocument(payload, { boardId: 'board-notes' }), true);
    assert.equal(payload.meetingNotes.activeSessionId, '');
    assert.equal(payload.meetingNotes.sessions['notes-1'].status, 'reset');
    assert.deepEqual(payload.meetingNotes.documentOrder, []);
    assert.equal(payload.agents[0].status, 'detached');
});

test('meeting notes publish one server-authored Blackboard refresh after a revision', async () => {
    const sent = [];
    const published = await publishMeetingNotesBlackboardUpdate({
        sendLiveKitRoomData: async (roomName, encoded, options) => sent.push({ roomName, encoded, options }),
    }, {
        roomId: 'room-1',
        roomName: 'livekit-room-1',
        boardId: 'board-notes',
        blackboardRevision: 12,
    });
    assert.equal(published, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].roomName, 'livekit-room-1');
    const event = parseWebMeetEvent(sent[0].encoded);
    assert.equal(event.type, WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(event.payload.boardId, 'board-notes');
    assert.equal(event.payload.blackboardRevision, 12);
    assert.equal(event.payload.reason, 'meeting_notes_revision');
});

test('legacy browser defaults restore Robo Team identity without changing custom names', () => {
    const migrated = normalizeRoboTeamSettings({
        assistant: {
            name: 'Assistant',
            mode: 'meeting-assistant',
            instructions: 'Help participants follow the room objective, keep the discussion clear, and summarize important points.',
            scenarioOrObjective: 'meeting',
        },
    });
    assert.equal(migrated.assistant.name, 'Robo Team');
    assert.match(migrated.assistant.instructions, /shared blackboard/);
    assert.equal(normalizeRoboTeamSettings({
        assistant: { name: 'My Assistant' },
    }).assistant.name, 'My Assistant');
});

test('enabling notes dispatches immediately and later joins reuse the Meeting Secretary', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-notes-dispatch-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    t.after(() => {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
    });
    process.env.WEBMEET_DATA_DIR = path.join(root, 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'meeting-notes-test-key';
    const context = installEdgeJoinFixture(await createStoreContext(root));
    context.scriptaExplorerClient = async () => ({ ok: true });
    const dispatches = [];
    const roomEvents = [];
    context.createLiveKitAgentDispatch = async (roomName, metadata) => {
        dispatches.push({ roomName, metadata });
        return { id: 'dispatch-1' };
    };
    context.sendLiveKitRoomData = async (roomName, encoded) => {
        roomEvents.push({ roomName, event: parseWebMeetEvent(encoded) });
    };
    const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
    const meeting = await createMeeting(context, { name: 'Notes room', authInfo });
    await updateRoboTeamSettings(context, {
        roomId: meeting.roomId,
        authInfo,
        settings: { meetingNotes: { enabled: true } },
    });
    assert.equal(dispatches.length, 1);
    assert.equal(roomEvents[0].event.type, WEBMEET_EVENT_TYPES.MEETING_NOTES_SETTINGS_CHANGED);
    assert.equal(roomEvents[1].event.type, WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(roomEvents[1].event.payload.objectKind, 'workspace');
    const workspace = await getRoomBlackboard(context, { roomId: meeting.roomId, authInfo });
    assert.ok(workspace.workspace.boards.some((board) => (
        board.boardId === roomEvents[1].event.payload.boardId
        && board.title === 'Meeting Notes'
        && board.purpose === 'meeting-notes'
        && board.systemManaged === true
    )));

    const first = await joinMeeting(context, {
        meetingId: meeting.roomId, displayName: 'Ana', participantId: 'ana', authInfo,
    });
    await joinMeeting(context, {
        meetingId: meeting.roomId, displayName: 'Mihai', participantId: 'mihai', authInfo,
    });

    assert.equal(first.meetingNotes.enabled, true);
    assert.match(first.meetingNotes.structurePrompt, /Ideas and proposals[\s\S]*Decisions[\s\S]*Questions[\s\S]*Risks[\s\S]*Actions[\s\S]*Unresolved points/);
    assert.equal(dispatches.length, 1);
    assert.equal(dispatches[0].metadata.agentType, 'meeting_secretary');

    const participantProjection = await getMeeting(context, meeting.roomId, {
        user: { id: 'local:participant', username: 'participant', roles: ['user'] },
    }, { includeParticipants: false });
    assert.deepEqual(participantProjection.meetingNotes, { enabled: true });

    await updateRoboTeamSettings(context, {
        roomId: meeting.roomId,
        authInfo,
        settings: { meetingNotes: { enabled: false } },
    });
    assert.equal(dispatches.length, 1);
    assert.equal(roomEvents.length, 3);
    assert.equal(roomEvents[2].event.payload.meetingId, meeting.roomId);
});

test('presence heartbeat redispatches a fresh persisted session whose LiveKit worker disappeared', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-notes-recovery-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    t.after(() => {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
    });
    process.env.WEBMEET_DATA_DIR = path.join(root, 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'meeting-notes-recovery-test-key';
    const context = installEdgeJoinFixture(await createStoreContext(root));
    context.scriptaExplorerClient = async () => ({ ok: true });
    const dispatches = [];
    context.createLiveKitAgentDispatch = async () => {
        dispatches.push(`dispatch-${dispatches.length + 1}`);
        return { id: dispatches.at(-1) };
    };
    const roomEvents = [];
    context.sendLiveKitRoomData = async (_roomName, encoded) => {
        roomEvents.push(parseWebMeetEvent(encoded));
    };
    let secretaryPresent = true;
    context.listLiveKitParticipants = async () => secretaryPresent
        ? [{ attributes: { webmeetMeetingSecretary: 'true', webmeetAgentType: 'meeting_secretary' } }]
        : [];
    const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
    const secretaryAuth = { agent: { principalId: 'agent:AchillesIDE/webmeetScribeAgent' } };
    const meeting = await createMeeting(context, { name: 'Recovery room', authInfo });
    await updateRoboTeamSettings(context, {
        roomId: meeting.roomId, authInfo, settings: { meetingNotes: { enabled: true } },
    });
    const started = await startMeetingNotesSession(context, {
        roomId: meeting.roomId, jobId: 'old-job', authInfo: secretaryAuth,
    });
    await heartbeatMeetingNotesSession(context, {
        roomId: meeting.roomId,
        sessionId: started.session.sessionId,
        activity: 'analyzing',
        pendingSegmentCount: 3,
        authInfo: secretaryAuth,
    });
    assert.equal(roomEvents.at(-1).type, WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY);
    assert.equal(roomEvents.at(-1).payload.phase, 'analyzing');
    assert.equal(roomEvents.at(-1).payload.pendingSegmentCount, 3);
    await joinMeeting(context, {
        meetingId: meeting.roomId, displayName: 'Ana', participantId: 'ana', authInfo,
    });
    assert.equal(dispatches.length, 1);

    secretaryPresent = false;
    const heartbeat = await heartbeatMeetingPresence(context, {
        meetingId: meeting.roomId, participantId: 'ana', authInfo,
    });
    assert.equal(heartbeat.meetingSecretaryRecovery.ok, true);
    assert.equal(dispatches.length, 2);
});

test('Meeting Notes activity renders authoritative editing phases in the room bar', async () => {
    const realtime = await fs.readFile(new URL(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js',
        import.meta.url,
    ), 'utf8');
    const rendering = await fs.readFile(new URL(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js',
        import.meta.url,
    ), 'utf8');
    const css = await fs.readFile(new URL(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css',
        import.meta.url,
    ), 'utf8');
    assert.match(realtime, /MEETING_NOTES_ACTIVITY/);
    assert.match(realtime, /MEETING_NOTES_SETTINGS_CHANGED[\s\S]*webmeet_room_get/);
    assert.doesNotMatch(realtime, /MEETING_NOTES_SETTINGS_CHANGED[\s\S]*webmeet_robo_team_get/);
    assert.match(rendering, /Meeting Notes editing — analyzing the complete discussion/);
    assert.match(rendering, /Meeting Notes editing — saving the document/);
    assert.match(rendering, /Meeting Notes paused — analysis failed; waiting for new speech/);
    assert.match(css, /webmeet-meeting-notes-spin/);
});

test('Meeting Notes document renders authoritative activity above its title', async () => {
    const html = await fs.readFile(new URL(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.html',
        import.meta.url,
    ), 'utf8');
    const statusPosition = html.indexOf('data-role="meeting-notes-status"');
    const titlePosition = html.indexOf('data-role="document-title"', statusPosition);
    assert.ok(statusPosition >= 0);
    assert.ok(titlePosition > statusPosition);

    assert.deepEqual(resolveMeetingNotesDocumentStatus({
        phase: 'analyzing', analysisRevision: 2, updatedAt: '2026-08-05T10:00:00.000Z',
    }), {
        phase: 'analyzing',
        revision: 2,
        updatedAt: '2026-08-05T10:00:00.000Z',
        label: 'Analyzing the discussion…',
        tone: 'working',
        working: true,
    });
    const updated = resolveMeetingNotesDocumentStatus({
        phase: 'listening', analysisRevision: 3, updatedAt: '2026-08-05T10:01:00.000Z',
    });
    assert.equal(updated.label, 'Meeting notes are up to date');
    assert.equal(updated.tone, 'success');
    assert.equal(updated.working, false);
    assert.equal(resolveMeetingNotesDocumentStatus({ enabled: false }).label, 'Meeting Notes is paused');
    assert.equal(resolveMeetingNotesDocumentStatus({
        enabled: true, transcriptionStatus: 'listening',
    }).label, 'Meeting Notes is listening');
    assert.equal(resolveMeetingNotesDocumentStatus({
        enabled: true, transcriptionStatus: 'paused',
    }).label, 'Meeting Notes starts when the microphone is on');
    assert.equal(resolveMeetingNotesDocumentStatus({
        enabled: true, phase: 'updating', transcriptionStatus: 'listening',
    }).label, 'Updating meeting notes…');
});
