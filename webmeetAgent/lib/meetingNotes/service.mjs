import crypto from 'node:crypto';

import { BlackboardWorkspace } from '../blackboard/workspace-model.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom,
} from '../store/roomRecords.mjs';
import {
    ensureRoboTeamAgentPayload,
    ensureRoboTeamBlackboardWorkspacePayload,
    normalizeRoboTeamSettings,
} from '../roboTeam/service.mjs';
import {
    createScriptaDocument,
    getScriptaDocumentSnapshot,
    mergeScriptaDocumentMarkdown,
    openScriptaDocument,
} from '../scripta/service.mjs';
import {
    createMeetingSecretaryDispatch,
    getParticipantAttributes,
    listLiveKitRoomParticipants,
    sendLiveKitRoomData,
} from '../runtime/livekitRuntime.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

export const MEETING_NOTES_BOARD_PURPOSE = 'meeting-notes';
export const MEETING_NOTES_BOARD_TITLE = 'Meeting Notes';
export const MEETING_SECRETARY_PARTICIPANT_ID = 'agent_meeting_secretary';
export const MEETING_SECRETARY_PRINCIPAL = 'agent:AchillesIDE/webmeetScribeAgent';
const DISPATCH_START_GRACE_MS = 30_000;
const SESSION_HEARTBEAT_GRACE_MS = 75_000;

const SECTION_DEFINITIONS = Object.freeze([
    ['summary', 'Summary'],
    ['ideas', 'Ideas and proposals'],
    ['decisions', 'Decisions'],
    ['questions', 'Questions'],
    ['risks', 'Risks'],
    ['actions', 'Actions'],
    ['unresolved', 'Unresolved points'],
]);

function nowIso() {
    return new Date().toISOString();
}

function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function syntheticSecretaryAuth() {
    return {
        agent: { principalId: MEETING_SECRETARY_PRINCIPAL, name: 'webmeetScribeAgent' },
    };
}

export function assertMeetingSecretaryAuth(authInfo = null) {
    const principal = String(authInfo?.agent?.principalId || '').trim().toLowerCase();
    if (principal !== MEETING_SECRETARY_PRINCIPAL.toLowerCase()) {
        throw new Error('Access denied: Meeting Secretary agent identity is required.');
    }
}

function ensureMeetingNotesState(payload) {
    payload.meetingNotes = payload.meetingNotes && typeof payload.meetingNotes === 'object'
        ? payload.meetingNotes
        : {};
    payload.meetingNotes.sessions = payload.meetingNotes.sessions && typeof payload.meetingNotes.sessions === 'object'
        ? payload.meetingNotes.sessions
        : {};
    payload.meetingNotes.activeSessionId = String(payload.meetingNotes.activeSessionId || '');
    payload.meetingNotes.documentOrder = Array.isArray(payload.meetingNotes.documentOrder)
        ? payload.meetingNotes.documentOrder.map(String)
        : [];
    for (const session of Object.values(payload.meetingNotes.sessions)) {
        if (!session || typeof session !== 'object') continue;
        if (!String(session.documentResourceId || '').trim() && String(session.resourceId || '').trim()) {
            session.documentResourceId = String(session.resourceId).trim();
        }
        delete session.resourceId;
    }
    return payload.meetingNotes;
}

function ensureMeetingNotesBoard(payload, roomId) {
    const agent = ensureRoboTeamAgentPayload(payload, null, roomId);
    const workspace = BlackboardWorkspace.from(ensureRoboTeamBlackboardWorkspacePayload(agent, roomId));
    let board = [...workspace.boards.values()].find((entry) => (
        String(entry.metadata?.purpose || '') === MEETING_NOTES_BOARD_PURPOSE
    ));
    const created = !board;
    if (created) {
        board = workspace.createBoard({ title: MEETING_NOTES_BOARD_TITLE }, { activate: false });
        board.metadata = { ...board.metadata, purpose: MEETING_NOTES_BOARD_PURPOSE, systemManaged: true };
    }
    agent.blackboardWorkspace = workspace.serializePrivileged();
    return {
        boardId: board.boardId,
        blackboardRevision: board.revision,
        workspaceRevision: workspace.revision,
        created,
    };
}

function activeSession(state) {
    const session = state.sessions[state.activeSessionId];
    return session && session.status !== 'finalized' ? session : null;
}

export function resetMeetingNotesForRemovedDocument(payload, { boardId = '', resourceId = '' } = {}) {
    const state = ensureMeetingNotesState(payload);
    const session = activeSession(state);
    if (!session) return false;
    const removesMeetingBoard = String(boardId || '') === String(session.boardId || '');
    const removesMeetingDocument = String(resourceId || '')
        && String(resourceId) === String(session.documentResourceId || '');
    if (!removesMeetingBoard && !removesMeetingDocument) return false;
    const documentResourceId = String(session.documentResourceId || '');
    session.status = 'reset';
    session.resetAt = nowIso();
    session.updatedAt = session.resetAt;
    session.lastMarkdown = '';
    session.lastProposalMarkdown = '';
    session.documentResourceId = '';
    session.documentName = '';
    session.sectionTargets = {};
    state.activeSessionId = '';
    state.documentOrder = state.documentOrder.filter((id) => id !== documentResourceId);
    const agent = (payload.agents || []).find((entry) => String(entry?.agentType || '') === 'meeting_secretary');
    if (agent) {
        agent.status = 'detached';
        agent.updatedAt = session.resetAt;
    }
    return true;
}

function timestampAge(value) {
    const timestamp = Date.parse(String(value || ''));
    return Number.isFinite(timestamp) ? Math.max(0, Date.now() - timestamp) : Number.POSITIVE_INFINITY;
}

function safeParticipants(payload) {
    return (Array.isArray(payload.members) ? payload.members : []).map((member) => ({
        participantId: String(member.id || '').trim(),
        displayName: String(member.displayName || member.name || member.id || 'Participant').trim(),
    })).filter((entry) => entry.participantId);
}

function isLiveMeetingSecretary(participant) {
    const attributes = getParticipantAttributes(participant);
    return String(attributes.webmeetMeetingSecretary || '').toLowerCase() === 'true'
        || String(attributes.webmeetAgentType || attributes.agentType || '').toLowerCase() === 'meeting_secretary';
}

async function getLiveMeetingSecretaryPresence(context, roomId) {
    const record = await loadRoomRecord(context, roomId);
    const payload = decryptRoomPayload(context, record);
    const settings = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
    const session = activeSession(ensureMeetingNotesState(payload));
    if (!settings.enabled || !session
        || timestampAge(session.lastHeartbeatAt || session.updatedAt) > SESSION_HEARTBEAT_GRACE_MS) {
        return null;
    }
    try {
        const participants = await listLiveKitRoomParticipants(context, record.roomName);
        return participants.some(isLiveMeetingSecretary);
    } catch {
        // A transient LiveKit control-plane failure must not create duplicate
        // dispatches; fall back to the bounded heartbeat lease for this check.
        return null;
    }
}

export async function ensureMeetingSecretaryDispatch(context, roomId) {
    const notesWorkspace = await ensureMeetingNotesWorkspace(context, roomId);
    const liveSecretaryPresent = await getLiveMeetingSecretaryPresence(context, roomId);
    let dispatchRequest = null;
    await mutateRoom(context, roomId, (record, payload) => {
        const settings = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
        if (!settings.enabled) return;
        payload.agents = Array.isArray(payload.agents) ? payload.agents : [];
        let agent = payload.agents.find((entry) => String(entry?.agentType || '') === 'meeting_secretary');
        const session = activeSession(ensureMeetingNotesState(payload));
        const sessionIsHealthy = Boolean(session)
            && timestampAge(session.lastHeartbeatAt || session.updatedAt) <= SESSION_HEARTBEAT_GRACE_MS
            && liveSecretaryPresent !== false;
        const dispatchIsStarting = agent
            && ['dispatching', 'dispatched'].includes(String(agent.status || ''))
            && timestampAge(agent.updatedAt) <= DISPATCH_START_GRACE_MS;
        if (sessionIsHealthy || dispatchIsStarting) return;
        const timestamp = nowIso();
        agent ||= { id: MEETING_SECRETARY_PARTICIPANT_ID, createdAt: timestamp };
        Object.assign(agent, {
            participantIdentity: String(agent.participantIdentity || ''),
            agentType: 'meeting_secretary',
            mode: 'cumulative_notes',
            agentName: 'Meeting Secretary',
            runtime: 'ploinky',
            status: 'dispatching',
            updatedAt: timestamp,
            deletedAt: null,
        });
        if (!payload.agents.includes(agent)) payload.agents.push(agent);
        dispatchRequest = { roomName: record.roomName, meetingId: record.meetingId };
    });
    if (!dispatchRequest) return { ok: true, existing: true, notesWorkspace };
    try {
        const dispatch = await createMeetingSecretaryDispatch(context, dispatchRequest.roomName, {
            meetingId: dispatchRequest.meetingId,
            agentType: 'meeting_secretary',
            mode: 'cumulative_notes',
        });
        await mutateRoom(context, roomId, (_record, payload, stageEvent) => {
            const agent = (payload.agents || []).find((entry) => entry.id === MEETING_SECRETARY_PARTICIPANT_ID);
            if (!agent) return;
            agent.status = 'dispatched';
            agent.dispatchId = String(dispatch?.id || dispatch?.dispatchId || '');
            agent.updatedAt = nowIso();
            stageEvent('meeting', 'agent.dispatched', {
                meetingId: roomId, agentId: agent.id, agentType: agent.agentType, mode: agent.mode,
            });
        });
        return { ok: true, dispatch, notesWorkspace };
    } catch (error) {
        await mutateRoom(context, roomId, (_record, payload) => {
            const agent = (payload.agents || []).find((entry) => entry.id === MEETING_SECRETARY_PARTICIPANT_ID);
            if (!agent || agent.status !== 'dispatching') return;
            agent.status = 'dispatch_failed';
            agent.updatedAt = nowIso();
        }).catch(() => {});
        throw error;
    }
}

export async function ensureMeetingNotesWorkspace(context, roomId) {
    let output = { created: false, boardId: '', blackboardRevision: 0, workspaceRevision: 0 };
    await mutateRoom(context, roomId, (record, payload, stageEvent) => {
        const settings = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
        if (!settings.enabled) return;
        output = ensureMeetingNotesBoard(payload, record.meetingId);
        if (!output.created) return;
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
            meetingId: record.meetingId,
            boardId: output.boardId,
            blackboardRevision: output.blackboardRevision,
            workspaceRevision: output.workspaceRevision,
            changeType: 'create',
            targetType: 'workspace',
            targetRef: output.boardId,
            reason: 'meeting_notes_workspace',
            objectKind: 'workspace',
        });
    });
    return output;
}

export async function startMeetingNotesSession(context, { roomId, jobId = '', authInfo = null } = {}) {
    assertMeetingSecretaryAuth(authInfo);
    let output = null;
    await mutateRoom(context, roomId, (record, payload) => {
        const settings = normalizeRoboTeamSettings(payload.roboTeamSettings);
        if (!settings.meetingNotes?.enabled) throw new Error('Meeting Notes is not enabled for this room.');
        const state = ensureMeetingNotesState(payload);
        let session = activeSession(state);
        if (!session) {
            const sessionId = `notes_${crypto.randomUUID()}`;
            session = {
                sessionId,
                roomId: record.meetingId,
                status: 'active',
                startedAt: nowIso(),
                updatedAt: nowIso(),
                lastHeartbeatAt: nowIso(),
                analysisRevision: 0,
                lastMarkdown: '',
                lastProposalMarkdown: '',
                jobId: String(jobId || ''),
                documentResourceId: '',
                documentName: '',
                sectionTargets: {},
            };
            state.sessions[sessionId] = session;
            state.activeSessionId = sessionId;
        } else {
            session.jobId = String(jobId || session.jobId || '');
            session.lastHeartbeatAt = nowIso();
            session.updatedAt = nowIso();
        }
        const secretaryAgent = (payload.agents || []).find((entry) => (
            String(entry?.agentType || '') === 'meeting_secretary'
        ));
        if (secretaryAgent) {
            secretaryAgent.status = 'active';
            secretaryAgent.updatedAt = nowIso();
            secretaryAgent.deletedAt = null;
        }
        const notesWorkspace = ensureMeetingNotesBoard(payload, record.meetingId);
        session.boardId = notesWorkspace.boardId;
        output = {
            ok: true,
            session: cloneJson(session),
            settings: cloneJson(settings.meetingNotes),
            participants: safeParticipants(payload),
            boardId: notesWorkspace.boardId,
        };
    });
    return output;
}

function normalizeAttributions(value) {
    return (Array.isArray(value) ? value : []).map((entry) => ({
        participantId: String(entry?.participantId || '').trim(),
        displayName: String(entry?.displayName || '').trim(),
    })).filter((entry) => entry.participantId);
}

function normalizeNote(entry) {
    return {
        id: String(entry?.id || '').trim(),
        text: String(entry?.text || '').replace(/\s+/g, ' ').trim(),
        attributions: normalizeAttributions(entry?.attributions),
        status: String(entry?.status || '').trim(),
        owner: String(entry?.owner || '').trim(),
        dueDate: String(entry?.dueDate || '').trim(),
    };
}

export function normalizeMeetingNotesDocument(value = {}) {
    const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const output = {
        title: String(input.title || 'Meeting Notes').trim() || 'Meeting Notes',
        summary: String(input.summary || '').trim(),
    };
    for (const [key] of SECTION_DEFINITIONS.slice(1)) {
        output[key] = (Array.isArray(input[key]) ? input[key] : [])
            .map(normalizeNote)
            .filter((entry) => entry.text);
    }
    return output;
}

function noteLine(note) {
    const names = note.attributions.map((entry) => entry.displayName || entry.participantId).filter(Boolean);
    const attribution = names.length ? `${names.join(', ')} — ` : '';
    const metadata = [
        note.owner ? `Owner: ${note.owner}` : '',
        note.dueDate ? `Due: ${note.dueDate}` : '',
        note.status ? `Status: ${note.status}` : '',
    ].filter(Boolean);
    return `${attribution}${note.text}${metadata.length ? ` (${metadata.join('; ')})` : ''}`;
}

function sectionText(document, key) {
    if (key === 'summary') return document.summary || 'No summary yet.';
    const notes = document[key] || [];
    return notes.length ? notes.map(noteLine).join('\n\n') : 'No items yet.';
}

function initializationChapters(document) {
    return SECTION_DEFINITIONS.map(([key, title]) => ({
        title,
        paragraphs: [{ text: sectionText(document, key) }],
    }));
}

function slugify(value) {
    return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
}

function normalizeMeetingNotesMarkdown(value) {
    const markdown = String(value || '').trim();
    if (!markdown || markdown.length > 60_000) throw new Error('Meeting-notes Markdown is invalid.');
    if (/<!--[\s\S]*?achilles-ide-/i.test(markdown)) throw new Error('Meeting-notes Markdown must not contain SCRIPTA metadata.');
    const lines = markdown.split(/\r?\n/);
    const titleHeadings = lines.filter((line) => /^#(?!#)\s+\S/.test(line.trim()));
    const title = lines[0]?.trim().match(/^#(?!#)\s+(.+)$/)?.[1]?.trim();
    if (!title || titleHeadings.length !== 1) {
        throw new Error('Meeting-notes Markdown requires exactly one leading title.');
    }
    if (!lines.some((line) => /^##(?!#)\s+\S/.test(line.trim()))) {
        throw new Error('Meeting-notes Markdown requires at least one chapter.');
    }
    return { markdown, title: title.slice(0, 200) };
}

function dateForTimeZone(timeZone = 'UTC', now = new Date()) {
    try {
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: String(timeZone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit',
        }).formatToParts(now);
        const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return `${byType.year}-${byType.month}-${byType.day}`;
    } catch {
        return now.toISOString().slice(0, 10);
    }
}

function projectionTargets(blackboard = {}) {
    const widget = (blackboard.widgets || []).find((entry) => entry.type === 'scripta-document');
    return projectionSectionTargets(widget?.properties);
}

function projectionSectionTargets(projection = {}) {
    const chapters = projection?.chapters || [];
    return Object.fromEntries(SECTION_DEFINITIONS.map(([key], index) => {
        const chapter = chapters[index];
        const paragraph = chapter?.paragraphs?.[0];
        return [key, {
            chapterId: String(chapter?.chapterId || chapter?.id || ''),
            paragraphId: String(paragraph?.paragraphId || paragraph?.id || ''),
            variantId: String(paragraph?.activeVariantId || paragraph?.selectedVariantId || ''),
        }];
    }));
}

async function recoverOrphanMeetingNotesDocument(context, roomId, session, documentName) {
    const record = await loadRoomRecord(context, roomId);
    const payload = decryptRoomPayload(context, record);
    const state = ensureMeetingNotesState(payload);
    const referencedResources = new Set(Object.values(state.sessions)
        .map((entry) => String(entry?.documentResourceId || ''))
        .filter(Boolean));
    const candidate = Object.values(payload.scripta?.documents || {}).find((entry) => {
        const fileName = String(entry?.path || '').split('/').pop();
        return fileName === documentName
            && String(entry?.boardId || '') === String(session.boardId || '')
            && !referencedResources.has(String(entry?.resourceId || ''));
    });
    if (!candidate?.resourceId) return null;
    const agent = (payload.agents || []).find((entry) => String(entry?.agentType || '') === 'robo_team');
    const workspace = agent?.blackboardWorkspace
        ? BlackboardWorkspace.from(agent.blackboardWorkspace)
        : null;
    const board = workspace?.getBoard(String(candidate.boardId || ''));
    return {
        documentResourceId: String(candidate.resourceId),
        documentName,
        sectionTargets: projectionSectionTargets(candidate.projection),
        blackboardUpdate: {
            boardId: String(candidate.boardId || session.boardId || ''),
            blackboardRevision: Number(board?.revision || 0),
        },
    };
}

export function hasCompleteMeetingNotesSectionTargets(session = {}) {
    return SECTION_DEFINITIONS.every(([key]) => {
        const target = session.sectionTargets?.[key];
        return Boolean(target?.chapterId && target?.paragraphId);
    });
}

export async function publishMeetingNotesBlackboardUpdate(context, {
    roomId,
    roomName,
    boardId,
    blackboardRevision,
} = {}) {
    if (!roomId || !roomName || !boardId || !Number(blackboardRevision)) return false;
    await sendLiveKitRoomData(context, roomName, buildWebMeetEvent(
        roomId,
        WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
        {
            meetingId: roomId,
            boardId,
            blackboardRevision: Number(blackboardRevision),
            changeType: 'update',
            targetType: 'widget',
            targetRef: 'robo_scripta_document',
            reason: 'meeting_notes_revision',
        },
    ));
    return true;
}

async function createNotesDocument(context, roomId, session, markdown, settings) {
    const date = dateForTimeZone(settings?.timeZone || 'UTC');
    const base = `${slugify(markdown.title) || 'meeting-notes'}-${date}`;
    const authInfo = syntheticSecretaryAuth();
    let lastError = null;
    for (let index = 1; index <= 100; index += 1) {
        const name = index === 1 ? base : `${base}-${index}`;
        try {
            const result = await createScriptaDocument(context, {
                roomId,
                name,
                boardId: session.boardId,
                template: 'general',
                initialization: {
                    title: `${markdown.title} — ${date}`,
                },
                participantId: MEETING_SECRETARY_PARTICIPANT_ID,
                authInfo,
            });
            return {
                documentResourceId: result.resourceId,
                documentName: `${name}.md`,
                sectionTargets: projectionTargets(result.blackboard),
                blackboardUpdate: {
                    boardId: String(result.blackboard?.boardId || session.boardId || ''),
                    blackboardRevision: Number(result.blackboard?.revision || 0),
                },
            };
        } catch (error) {
            lastError = error;
            if (error?.documentCreated === true && String(error?.documentName || '').trim()) {
                const opened = await openScriptaDocument(context, {
                    roomId,
                    path: String(error.documentName),
                    boardId: session.boardId,
                    participantId: MEETING_SECRETARY_PARTICIPANT_ID,
                    authInfo,
                });
                return {
                    documentResourceId: opened.resourceId,
                    documentName: String(error.documentName),
                    sectionTargets: projectionTargets(opened.blackboard),
                    blackboardUpdate: {
                        boardId: String(opened.blackboard?.boardId || session.boardId || ''),
                        blackboardRevision: Number(opened.blackboard?.revision || 0),
                    },
                };
            }
            if (!/already|available|attached/i.test(String(error?.message || ''))) throw error;
            const recovered = await recoverOrphanMeetingNotesDocument(
                context,
                roomId,
                session,
                `${name}.md`,
            );
            if (recovered) return recovered;
        }
    }
    throw lastError || new Error('Unable to allocate a meeting-notes document name.');
}

async function ensureEmptyMeetingNotesDocument(context, {
    roomId,
    sessionId,
} = {}) {
    const record = await loadRoomRecord(context, roomId);
    const payload = decryptRoomPayload(context, record);
    const state = ensureMeetingNotesState(payload);
    const session = state.sessions[String(sessionId || '')];
    if (!session || session.status !== 'active' || session.documentResourceId) {
        return session ? { session: cloneJson(session), blackboardUpdate: null } : null;
    }
    const settings = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
    const attachment = await createNotesDocument(
        context,
        roomId,
        session,
        { title: 'Meeting Notes' },
        settings,
    );
    let output = null;
    await mutateRoom(context, roomId, (_freshRecord, freshPayload) => {
        const freshState = ensureMeetingNotesState(freshPayload);
        const freshSession = freshState.sessions[String(sessionId || '')];
        if (!freshSession || freshSession.status !== 'active') {
            throw new Error('Meeting-notes session changed while creating its document.');
        }
        if (!freshSession.documentResourceId) {
            freshSession.documentResourceId = attachment.documentResourceId;
            freshSession.documentName = attachment.documentName;
            freshSession.sectionTargets = attachment.sectionTargets;
            freshSession.updatedAt = nowIso();
            if (!freshState.documentOrder.includes(attachment.documentResourceId)) {
                freshState.documentOrder.unshift(attachment.documentResourceId);
            }
        }
        delete freshSession.documentCreationStartedAt;
        output = {
            session: cloneJson(freshSession),
            blackboardUpdate: attachment.blackboardUpdate,
        };
    });
    return output;
}

async function updateNotesDocument(context, roomId, session, markdown, baseStateBase64 = '') {
    const authInfo = syntheticSecretaryAuth();
    const result = await mergeScriptaDocumentMarkdown(context, {
        roomId,
        resourceId: session.documentResourceId,
        markdown: markdown.markdown,
        baseStateBase64,
        command: `meeting-notes Markdown revision ${session.analysisRevision + 1}`,
        participantId: MEETING_SECRETARY_PARTICIPANT_ID,
        authInfo,
    });
    return {
        markdown: String(result?.markdown || markdown.markdown),
        documentSnapshot: result?.documentSnapshot || null,
        blackboardUpdate: result?.blackboard?.boardId && Number(result.blackboard?.revision)
            ? { boardId: String(result.blackboard.boardId), blackboardRevision: Number(result.blackboard.revision) }
            : null,
    };
}

export async function applyMeetingNotesDocument(context, {
    roomId,
    sessionId,
    analysisRevision,
    markdown: proposedMarkdown,
    baseStateBase64 = '',
    authInfo = null,
} = {}) {
    assertMeetingSecretaryAuth(authInfo);
    const markdown = normalizeMeetingNotesMarkdown(proposedMarkdown);
    const record = await loadRoomRecord(context, roomId);
    const initialPayload = decryptRoomPayload(context, record);
    const state = ensureMeetingNotesState(initialPayload);
    const session = state.sessions[String(sessionId || '')];
    if (!session || session.status === 'finalized') throw new Error('Meeting-notes session is not active.');
    const revision = Number(analysisRevision);
    if (!Number.isSafeInteger(revision)) {
        throw new Error('Meeting-notes analysis revision is stale or out of order.');
    }
    // A caller can lose the HTTP response after the mutation commits. Retrying
    // the same durable revision must repair the physical Markdown file from
    // that durable source, instead of making the worker regenerate the whole
    // meeting document.
    if (revision === Number(session.analysisRevision || 0) && session.lastProposalMarkdown === markdown.markdown) {
        return { ok: true, session: cloneJson(session), markdown: session.lastMarkdown, idempotent: true };
    }
    if (revision !== Number(session.analysisRevision || 0) + 1) {
        throw new Error('Meeting-notes analysis revision is stale or out of order.');
    }
    const settings = normalizeRoboTeamSettings(initialPayload.roboTeamSettings).meetingNotes;
    let attachment = null;
    let blackboardUpdate = null;
    if (!session.documentResourceId) {
        attachment = await createNotesDocument(context, roomId, session, markdown, settings);
        session.documentResourceId = attachment.documentResourceId;
        session.documentName = attachment.documentName;
        session.sectionTargets = attachment.sectionTargets;
        blackboardUpdate = attachment.blackboardUpdate;
    }
    const merged = await updateNotesDocument(context, roomId, session, markdown, baseStateBase64);
    blackboardUpdate = merged.blackboardUpdate || blackboardUpdate;
    let output = null;
    await mutateRoom(context, roomId, (_record, payload) => {
        const freshState = ensureMeetingNotesState(payload);
        const freshSession = freshState.sessions[session.sessionId];
        if (!freshSession || Number(freshSession.analysisRevision || 0) + 1 !== revision) {
            throw new Error('Meeting-notes session changed while applying the document.');
        }
        if (attachment) {
            freshSession.documentResourceId = attachment.documentResourceId;
            freshSession.documentName = attachment.documentName;
            freshSession.sectionTargets = attachment.sectionTargets;
            if (!freshState.documentOrder.includes(attachment.documentResourceId)) {
                freshState.documentOrder.unshift(attachment.documentResourceId);
            }
        }
        freshSession.analysisRevision = revision;
        freshSession.updatedAt = nowIso();
        freshSession.lastProposalMarkdown = markdown.markdown;
        freshSession.lastMarkdown = merged.markdown;
        delete freshSession.lastDocument;
        output = {
            ok: true,
            session: cloneJson(freshSession),
            markdown: merged.markdown,
            documentSnapshot: merged.documentSnapshot,
        };
    });
    await publishMeetingNotesBlackboardUpdate(context, {
        roomId,
        roomName: record.roomName,
        boardId: blackboardUpdate?.boardId || session.boardId,
        blackboardRevision: blackboardUpdate?.blackboardRevision,
    }).catch(() => {});
    return output;
}

export async function heartbeatMeetingNotesSession(context, {
    roomId, sessionId, activity = '', pendingSegmentCount = 0,
    includeDocumentSnapshot = false, authInfo = null,
} = {}) {
    assertMeetingSecretaryAuth(authInfo);
    const allowedActivities = new Set(['listening', 'queued', 'analyzing', 'updating', 'retrying', 'waiting_for_new_speech']);
    const normalizedActivity = allowedActivities.has(String(activity || '')) ? String(activity) : '';
    let roomName = '';
    let output = null;
    let shouldEnsureEmptyDocument = false;
    await mutateRoom(context, roomId, (record, payload) => {
        roomName = record.roomName;
        const state = ensureMeetingNotesState(payload);
        const session = state.sessions[String(sessionId || '')];
        if (!session || session.status !== 'active') {
            output = { ok: true, reset: true, participants: safeParticipants(payload), settings: cloneJson(normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes) };
            return;
        }
        session.lastHeartbeatAt = nowIso();
        session.updatedAt = nowIso();
        if (normalizedActivity) {
            session.activity = normalizedActivity;
            session.pendingSegmentCount = Math.max(0, Math.floor(Number(pendingSegmentCount || 0)));
            session.activityUpdatedAt = session.updatedAt;
        }
        if (
            normalizedActivity === 'queued'
            && Number(pendingSegmentCount || 0) > 0
            && !session.documentResourceId
            && timestampAge(session.documentCreationStartedAt) > 30_000
        ) {
            session.documentCreationStartedAt = session.updatedAt;
            shouldEnsureEmptyDocument = true;
        }
        const settings = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
        output = {
            ok: true,
            session: cloneJson(session),
            participants: safeParticipants(payload),
            settings: cloneJson(settings),
        };
    });
    if (normalizedActivity) {
        await sendLiveKitRoomData(context, roomName, buildWebMeetEvent(
            roomId,
            WEBMEET_EVENT_TYPES.MEETING_NOTES_ACTIVITY,
            {
                meetingId: roomId,
                phase: normalizedActivity,
                pendingSegmentCount: Math.max(0, Math.floor(Number(pendingSegmentCount || 0))),
                analysisRevision: Number(output?.session?.analysisRevision || 0),
            },
        )).catch(() => {});
    }
    if (shouldEnsureEmptyDocument) {
        let ensured;
        try {
            ensured = await ensureEmptyMeetingNotesDocument(context, { roomId, sessionId });
        } catch (error) {
            await mutateRoom(context, roomId, (_record, payload) => {
                const session = ensureMeetingNotesState(payload).sessions[String(sessionId || '')];
                if (session && !session.documentResourceId) delete session.documentCreationStartedAt;
            }).catch(() => {});
            throw error;
        }
        if (ensured?.session) output.session = ensured.session;
        if (ensured?.blackboardUpdate) {
            await publishMeetingNotesBlackboardUpdate(context, {
                roomId,
                roomName,
                boardId: ensured.blackboardUpdate.boardId || output.session?.boardId,
                blackboardRevision: ensured.blackboardUpdate.blackboardRevision,
            }).catch(() => {});
        }
    }
    if (includeDocumentSnapshot === true && output?.session?.documentResourceId) {
        output.documentSnapshot = await getScriptaDocumentSnapshot(context, {
            roomId,
            resourceId: output.session.documentResourceId,
            participantId: MEETING_SECRETARY_PARTICIPANT_ID,
            authInfo: syntheticSecretaryAuth(),
        });
    }
    return output;
}

export async function finalizeMeetingNotesSession(context, { roomId, sessionId, authInfo = null } = {}) {
    assertMeetingSecretaryAuth(authInfo);
    let output = null;
    await mutateRoom(context, roomId, (_record, payload) => {
        const state = ensureMeetingNotesState(payload);
        const session = state.sessions[String(sessionId || '')];
        if (!session) throw new Error('Meeting-notes session was not found.');
        session.status = 'finalized';
        session.finalizedAt = nowIso();
        session.updatedAt = nowIso();
        if (state.activeSessionId === session.sessionId) state.activeSessionId = '';
        const agent = (payload.agents || []).find((entry) => (
            String(entry?.agentType || '') === 'meeting_secretary'
        ));
        if (agent) {
            agent.status = 'detached';
            agent.deletedAt = session.finalizedAt;
            agent.updatedAt = session.finalizedAt;
        }
        output = { ok: true, session: cloneJson(session) };
    });
    return output;
}
