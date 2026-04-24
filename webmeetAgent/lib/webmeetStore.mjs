import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';
import { resolveVarValue, setEnvVar } from './secretVars.mjs';
import { createWrappedDek, decryptPayload, deriveMasterKey, encryptPayload, unwrapDek } from './webmeetCrypto.mjs';
import { generateAssistantReply, generateObserverSummary, generateScribeOutput } from './webmeetLLM.mjs';
import { appendEventLog, enqueueJob, waitForJob } from './webmeetQueue.mjs';

const MASTER_KEY_VAR = 'PLOINKY_WEBMEET_MASTER_KEY';
const RETENTION_DAYS_VAR = 'PLOINKY_WEBMEET_RETENTION_DAYS';
const DEFAULT_RETENTION_DAYS = 30;
const ACTIVE_RECORDING_STATUSES = new Set([
    'recording',
    'EGRESS_STARTING',
    'EGRESS_ACTIVE',
    'EGRESS_LIMIT_REACHED'
]);

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function deriveWorkspaceId(workspaceRoot) {
    const digest = crypto.createHash('sha256').update(String(workspaceRoot || '/')).digest('hex').slice(0, 16);
    return `workspace_${digest}`;
}

function deriveWorkspaceName(workspaceRoot) {
    const normalized = String(workspaceRoot || '').replace(/\\/g, '/').replace(/\/+$/g, '');
    const leaf = normalized.split('/').filter(Boolean).pop() || 'Workspace';
    return leaf;
}

function ensureDirs(paths) {
    fs.mkdirSync(paths.workspacesDir, { recursive: true });
    fs.mkdirSync(paths.meetingsDir, { recursive: true });
    fs.mkdirSync(paths.eventsDir, { recursive: true });
    fs.mkdirSync(paths.jobsPendingDir, { recursive: true });
    fs.mkdirSync(paths.jobsProcessingDir, { recursive: true });
    fs.mkdirSync(paths.jobsDoneDir, { recursive: true });
    fs.mkdirSync(paths.jobsFailedDir, { recursive: true });
}

function readConfigValue(workspaceRoot, name) {
    const secret = resolveVarValue(workspaceRoot, name);
    if (secret && String(secret).trim()) {
        return String(secret).trim();
    }
    const env = process.env[name];
    return env && String(env).trim() ? String(env).trim() : '';
}

function getRetentionDays(workspaceRoot) {
    const raw = readConfigValue(workspaceRoot, RETENTION_DAYS_VAR);
    const parsed = parseInt(raw || '', 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
        return parsed;
    }
    return DEFAULT_RETENTION_DAYS;
}

function ensureMasterKey(workspaceRoot) {
    let raw = readConfigValue(workspaceRoot, MASTER_KEY_VAR);
    if (!raw) {
        raw = crypto.randomBytes(32).toString('base64');
        setEnvVar(workspaceRoot, MASTER_KEY_VAR, raw);
    }
    return deriveMasterKey(raw);
}

function filePathFor(dir, id) {
    return path.join(dir, `${id}.json`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, record) {
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
}

function listJsonFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
}

function purgeExpiredMeetings(paths) {
    const now = Date.now();
    for (const filePath of listJsonFiles(paths.meetingsDir)) {
        try {
            const record = readJsonFile(filePath);
            if (record?.expiresAt && now > Date.parse(record.expiresAt)) {
                fs.unlinkSync(filePath);
            }
        } catch (_) {
            // ignore malformed
        }
    }
}

function createMeetingPayload() {
    return {
        members: [],
        agents: [],
        chatMessages: [],
        transcriptSegments: [],
        recordings: [],
        artifacts: [],
        tasks: [],
        decisions: [],
        events: [],
        observerState: {
            summary: '',
            updatedAt: null
        }
    };
}

function loadMeetingRecord(context, meetingId) {
    const filePath = filePathFor(context.meetingsDir, meetingId);
    if (!fs.existsSync(filePath)) {
        throw new Error('Meeting not found.');
    }
    return readJsonFile(filePath);
}

function decryptMeetingPayload(context, record) {
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const dek = unwrapDek(masterKey, record.dek);
    return decryptPayload(dek, record.payload);
}

function saveMeetingRecord(context, record, payload) {
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const dek = unwrapDek(masterKey, record.dek);
    record.payload = encryptPayload(dek, payload);
    record.updatedAt = nowIso();
    writeJsonFile(filePathFor(context.meetingsDir, record.meetingId), record);
}

function mutateMeeting(context, meetingId, mutator) {
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    const result = mutator(record, payload) || {};
    saveMeetingRecord(context, record, payload);
    return { record, payload, result };
}

function addMeetingEvent(payload, type, data = {}) {
    const event = {
        id: randomId('event'),
        type,
        payload: data,
        createdAt: nowIso()
    };
    payload.events.push(event);
    return event;
}

function recordMeetingEvent(context, meetingId, payload, type, data = {}) {
    const event = addMeetingEvent(payload, type, data);
    appendEventLog(context.workspaceRoot, meetingId, event);
    return event;
}

function buildRoomName(prefix, workspaceId, meetingId) {
    return `${prefix}-${workspaceId}-${meetingId}`
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 160);
}

function createLiveKitToken(context, { roomName, identity, name }) {
    if (!context.livekitApiKey || !context.livekitApiSecret) {
        return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: context.livekitApiKey,
        sub: identity,
        iat: now,
        nbf: now,
        exp: now + 60 * 60 * 8,
        name,
        video: {
            room: roomName,
            roomJoin: true,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true
        }
    })).toString('base64url');
    const signature = crypto
        .createHmac('sha256', context.livekitApiSecret)
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${signature}`;
}

function summarizeMeetingPayload(payload, meetingTitle, closedAt) {
    const candidateLines = [...payload.chatMessages, ...payload.transcriptSegments]
        .map((entry) => entry.message || entry.text || '')
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);

    for (const line of candidateLines) {
        if ((/^task[:\-]/i.test(line) || /\b(todo|action item|follow up)\b/i.test(line))) {
            const title = line.replace(/^task[:\-]\s*/i, '').trim();
            if (title && !payload.tasks.some((entry) => entry.title === title)) {
                payload.tasks.push({ id: randomId('task'), title, status: 'open', createdAt: nowIso() });
            }
        }
        if ((/^decision[:\-]/i.test(line) || /\bdecided\b/i.test(line))) {
            const title = line.replace(/^decision[:\-]\s*/i, '').trim();
            if (title && !payload.decisions.some((entry) => entry.title === title)) {
                payload.decisions.push({ id: randomId('decision'), title, createdAt: nowIso() });
            }
        }
    }

    return {
        id: randomId('artifact'),
        type: 'minutes-of-meeting',
        title: `${meetingTitle} Minutes`,
        body: [
            `Meeting: ${meetingTitle}`,
            `Closed: ${closedAt}`,
            '',
            `Chat messages: ${payload.chatMessages.length}`,
            `Transcript segments: ${payload.transcriptSegments.length}`,
            '',
            'Decisions:',
            ...(payload.decisions.length ? payload.decisions.map((entry) => `- ${entry.title}`) : ['- None']),
            '',
            'Tasks:',
            ...(payload.tasks.length ? payload.tasks.map((entry) => `- ${entry.title}`) : ['- None'])
        ].join('\n'),
        createdAt: nowIso()
    };
}

function buildRecentTranscriptText(payload, limit = 12) {
    return payload.transcriptSegments
        .slice(-limit)
        .map((entry) => `${entry.speakerName || entry.speakerId || 'speaker'}: ${entry.text || ''}`)
        .join('\n');
}

function buildRecentChatText(payload, limit = 12) {
    return payload.chatMessages
        .slice(-limit)
        .map((entry) => `${entry.authorName || entry.authorId || 'user'}: ${entry.message || ''}`)
        .join('\n');
}

async function refreshObserverState(context, meetingId) {
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    const observer = payload.agents.find((entry) => entry.agentType === 'observer' && entry.mode === 'passive');
    if (!observer) {
        return null;
    }
    let summary = '';
    try {
        summary = await generateObserverSummary({
            meetingTitle: record.title,
            chatText: buildRecentChatText(payload),
            transcriptText: buildRecentTranscriptText(payload),
            previousSummary: payload.observerState?.summary || ''
        });
    } catch (_error) {
        summary = [
            'Topics:',
            buildRecentChatText(payload, 4) || 'No recent chat.',
            '',
            'Transcript:',
            buildRecentTranscriptText(payload, 4) || 'No recent transcript.'
        ].join('\n');
    }
    mutateMeeting(context, meetingId, (_record, nextPayload) => {
        nextPayload.observerState = {
            summary,
            updatedAt: nowIso()
        };
    });
    return summary;
}

function buildMeetingView(record) {
    return {
        id: record.meetingId,
        workspaceId: record.workspaceId,
        title: record.title,
        roomName: record.roomName,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        closedAt: record.closedAt || null
    };
}

export function getMeeting(context, meetingId) {
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    return {
        meeting: buildMeetingView(record),
        participants: payload.members,
        agents: payload.agents,
        observerState: payload.observerState,
        recordings: payload.recordings
    };
}

export function buildMeetingAiContext(context, meetingId) {
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    return {
        meeting: buildMeetingView(record),
        observerSummary: payload.observerState?.summary || '',
        chatText: buildRecentChatText(payload, 50),
        transcriptText: buildRecentTranscriptText(payload, 50),
        tasks: payload.tasks.map((entry) => ({ ...entry })),
        decisions: payload.decisions.map((entry) => ({ ...entry })),
        agents: payload.agents.map((entry) => ({ ...entry })),
        payload
    };
}

export function persistObserverSummary(context, meetingId, summary) {
    mutateMeeting(context, meetingId, (_record, payload) => {
        payload.observerState = {
            summary: String(summary || '').trim(),
            updatedAt: nowIso()
        };
    });
    return getMeeting(context, meetingId).observerState;
}

export function persistAssistantMessage(context, meetingId, { agentId, message }) {
    let assistantMessage = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        assistantMessage = {
            id: randomId('chat'),
            meetingId,
            authorId: agentId,
            authorName: context.agentName,
            message: String(message || '').trim(),
            kind: 'agent',
            createdAt: nowIso()
        };
        payload.chatMessages.push(assistantMessage);
        recordMeetingEvent(context, meetingId, payload, 'chat.message.created', { meetingId, chatMessageId: assistantMessage.id, kind: 'agent' });
    });
    return assistantMessage;
}

export function finalizeMeetingWithScribe(context, meetingId, { summary, tasks = [], decisions = [] }) {
    let artifact = null;
    let meeting = null;
    mutateMeeting(context, meetingId, (record, payload) => {
        record.status = 'closed';
        record.closedAt = record.closedAt || nowIso();
        for (const title of decisions.map((entry) => String(entry || '').trim()).filter(Boolean)) {
            if (!payload.decisions.some((entry) => entry.title === title)) {
                payload.decisions.push({ id: randomId('decision'), title, createdAt: nowIso() });
            }
        }
        for (const item of tasks) {
            const title = String(item?.title || '').trim();
            if (!title || payload.tasks.some((entry) => entry.title === title)) {
                continue;
            }
            payload.tasks.push({ id: randomId('task'), title, status: String(item?.status || 'open'), createdAt: nowIso() });
        }
        artifact = {
            id: randomId('artifact'),
            type: 'minutes-of-meeting',
            title: `${record.title} Minutes`,
            body: String(summary || '').trim(),
            createdAt: nowIso()
        };
        payload.artifacts.push(artifact);
        meeting = buildMeetingView(record);
        recordMeetingEvent(context, meetingId, payload, 'meeting.ended', { meetingId });
        recordMeetingEvent(context, meetingId, payload, 'artifact.created', { meetingId, artifactId: artifact.id });
    });
    const payload = decryptMeetingPayload(context, loadMeetingRecord(context, meetingId));
    return { meeting, artifact, tasks: payload.tasks, decisions: payload.decisions };
}

export function createStoreContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    ensureDirs(paths);
    purgeExpiredMeetings(paths);
    return {
        ...paths,
        roomPrefix: String(process.env.WEBMEET_ROOM_PREFIX || 'webmeet').trim() || 'webmeet',
        agentName: String(process.env.WEBMEET_AGENT_NAME || 'WebMeetAgent').trim() || 'WebMeetAgent',
        livekitPublicUrl: String(process.env.WEBMEET_PUBLIC_LIVEKIT_URL || process.env.WEBMEET_LIVEKIT_URL || '').trim(),
        livekitApiUrl: String(process.env.WEBMEET_LIVEKIT_URL || '').trim(),
        livekitApiKey: String(process.env.WEBMEET_LIVEKIT_API_KEY || '').trim(),
        livekitApiSecret: String(process.env.WEBMEET_LIVEKIT_API_SECRET || '').trim(),
        egressUrl: String(process.env.WEBMEET_EGRESS_URL || '').trim(),
        recordingsDir: String(process.env.WEBMEET_RECORDINGS_DIR || '/recordings').trim() || '/recordings'
    };
}

async function callEgressApi(context, methodName, payload) {
    if (!context.livekitApiUrl || !context.livekitApiKey || !context.livekitApiSecret) {
        throw new Error('LiveKit API configuration is missing.');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({
        iss: context.livekitApiKey,
        sub: `${context.agentName}-egress`,
        iat: now,
        nbf: now,
        exp: now + 60 * 10,
        video: {
            roomRecord: true
        }
    })).toString('base64url');
    const signature = crypto
        .createHmac('sha256', context.livekitApiSecret)
        .update(`${header}.${body}`)
        .digest('base64url');
    const token = `${header}.${body}.${signature}`;
    const response = await fetch(`${context.livekitApiUrl.replace(/\/+$/g, '')}/twirp/livekit.Egress/${methodName}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
    });
    const text = await response.text();
    let parsed = {};
    try {
        parsed = text ? JSON.parse(text) : {};
    } catch (_) {
        parsed = { raw: text };
    }
    if (!response.ok) {
        throw new Error(parsed?.msg || parsed?.message || text || `Egress API ${methodName} failed.`);
    }
    return parsed;
}

function ensureCurrentWorkspaceRecord(context) {
    const id = deriveWorkspaceId(context.workspaceRoot);
    const filePath = filePathFor(context.workspacesDir, id);
    const createdAt = nowIso();
    const nextRecord = {
        id,
        name: deriveWorkspaceName(context.workspaceRoot),
        rootPath: context.workspaceRoot,
        createdAt,
        updatedAt: createdAt
    };
    if (fs.existsSync(filePath)) {
        const current = readJsonFile(filePath);
        const merged = { ...current, ...nextRecord, createdAt: current.createdAt || createdAt, updatedAt: nowIso() };
        writeJsonFile(filePath, merged);
        return merged;
    }
    writeJsonFile(filePath, nextRecord);
    return nextRecord;
}

export function listWorkspaces(context) {
    return [ensureCurrentWorkspaceRecord(context)];
}

export function createWorkspace(context, _input = {}) {
    return ensureCurrentWorkspaceRecord(context);
}

export function listMeetings(context, workspaceId) {
    const workspace = ensureCurrentWorkspaceRecord(context);
    const effectiveWorkspaceId = String(workspaceId || '').trim() || workspace.id;
    return listJsonFiles(context.meetingsDir).map(readJsonFile).filter((entry) => entry.workspaceId === effectiveWorkspaceId).map((entry) => ({
        id: entry.meetingId,
        workspaceId: entry.workspaceId,
        title: entry.title,
        roomName: entry.roomName,
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        closedAt: entry.closedAt || null
    }));
}

export function createMeeting(context, { workspaceId, title }) {
    const workspace = ensureCurrentWorkspaceRecord(context);
    const effectiveWorkspaceId = String(workspaceId || '').trim() || workspace.id;
    if (effectiveWorkspaceId !== workspace.id) {
        throw new Error('Workspace mismatch for current Explorer workspace.');
    }
    const meetingId = randomId('meeting');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + getRetentionDays(context.workspaceRoot) * 24 * 60 * 60 * 1000).toISOString();
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const { wrapped, dek } = createWrappedDek(masterKey);
    const payload = createMeetingPayload();
    recordMeetingEvent(context, meetingId, payload, 'meeting.created', { meetingId });
    const record = {
        version: 1,
        meetingId,
        workspaceId: effectiveWorkspaceId,
        title,
        roomName: buildRoomName(context.roomPrefix, effectiveWorkspaceId, meetingId),
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        closedAt: null,
        expiresAt,
        dek: wrapped,
        payload: encryptPayload(dek, payload)
    };
    writeJsonFile(filePathFor(context.meetingsDir, meetingId), record);
    return {
        id: record.meetingId,
        workspaceId: record.workspaceId,
        title: record.title,
        roomName: record.roomName,
        status: record.status,
        createdAt: record.createdAt,
        closedAt: record.closedAt
    };
}

export function joinMeeting(context, { meetingId, displayName, participantId }) {
    const participantIdentity = String(participantId || randomId('participant')).trim();
    let participant = null;
    const { record } = mutateMeeting(context, meetingId, (_record, payload) => {
        participant = payload.members.find((entry) => entry.id === participantIdentity) || null;
        if (!participant) {
            participant = { id: participantIdentity, displayName, joinedAt: nowIso() };
            payload.members.push(participant);
            recordMeetingEvent(context, meetingId, payload, 'participant.joined', { meetingId, participantId: participant.id });
        }
    });
    return {
        meeting: {
            id: record.meetingId,
            workspaceId: record.workspaceId,
            title: record.title,
            roomName: record.roomName,
            status: record.status,
            createdAt: record.createdAt,
            closedAt: record.closedAt || null
        },
        participant,
        livekitUrl: context.livekitPublicUrl,
        roomName: record.roomName,
        participantToken: createLiveKitToken(context, { roomName: record.roomName, identity: participant.id, name: displayName }),
        participantIdentity: participant.id
    };
}

export function listMeetingChat(context, meetingId) {
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).chatMessages;
}

export async function appendMeetingChat(context, { meetingId, authorId, authorName, message }) {
    let chatMessage = null;
    let shouldRefreshObserver = false;
    let assistantAgent = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        chatMessage = { id: randomId('chat'), meetingId, authorId, authorName, message, kind: 'user', createdAt: nowIso() };
        payload.chatMessages.push(chatMessage);
        recordMeetingEvent(context, meetingId, payload, 'chat.message.created', { meetingId, chatMessageId: chatMessage.id });
        shouldRefreshObserver = payload.agents.some((entry) => entry.agentType === 'observer' && entry.mode === 'passive');
        if (message.includes(`@${context.agentName}`)) {
            assistantAgent = payload.agents.find((entry) => entry.agentType === 'assistant_on_mention' && entry.mode === 'on_mention') || null;
            if (assistantAgent) recordMeetingEvent(context, meetingId, payload, 'agent.mentioned', { meetingId, agentName: context.agentName });
        }
    });
    let assistantMessage = null;
    if (shouldRefreshObserver) {
        enqueueJob(context.workspaceRoot, 'observer_refresh', { meetingId });
    }
    if (assistantAgent) {
        const job = enqueueJob(context.workspaceRoot, 'assistant_reply', {
            meetingId,
            agentId: assistantAgent.id,
            userMessage: message
        });
        const completed = await waitForJob(context.workspaceRoot, job.id, 15000);
        assistantMessage = completed.result?.assistantMessage || null;
    }
    return { message: chatMessage, assistantMessage };
}

export async function appendMeetingTranscript(context, { meetingId, speakerId, speakerName, text }) {
    let segment = null;
    let shouldRefreshObserver = false;
    mutateMeeting(context, meetingId, (_record, payload) => {
        segment = { id: randomId('transcript'), meetingId, speakerId, speakerName, text, createdAt: nowIso() };
        payload.transcriptSegments.push(segment);
        recordMeetingEvent(context, meetingId, payload, 'transcript.updated', { meetingId, segmentId: segment.id });
        shouldRefreshObserver = payload.agents.some((entry) => entry.agentType === 'observer' && entry.mode === 'passive');
    });
    if (shouldRefreshObserver) {
        enqueueJob(context.workspaceRoot, 'observer_refresh', { meetingId });
    }
    return segment;
}

export function listMeetingTranscript(context, meetingId) {
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).transcriptSegments;
}

export function attachMeetingAgent(context, { meetingId, agentType, mode }) {
    let agent = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        agent = { id: randomId('agent'), meetingId, agentType, mode, createdAt: nowIso() };
        payload.agents.push(agent);
    });
    return agent;
}

export function listMeetingAgents(context, meetingId) {
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).agents;
}

export async function startMeetingRecording(context, meetingId) {
    let recording = null;
    const meetingRecord = loadMeetingRecord(context, meetingId);
    const meetingPayload = decryptMeetingPayload(context, meetingRecord);
    const activeRecording = [...meetingPayload.recordings].reverse().find((entry) => ACTIVE_RECORDING_STATUSES.has(String(entry.status || ''))) || null;
    if (activeRecording) {
        throw new Error('A recording is already active for this meeting.');
    }
    const recordingId = randomId('recording');
    const outputFilePath = path.posix.join(context.recordingsDir, meetingId, `${recordingId}.mp4`);
    const egressInfo = await callEgressApi(context, 'StartRoomCompositeEgress', {
        room_name: meetingRecord.roomName,
        layout: 'grid-light',
        file_outputs: [{
            filepath: outputFilePath
        }]
    });
    mutateMeeting(context, meetingId, (record, payload) => {
        recording = {
            id: recordingId,
            meetingId,
            roomName: record.roomName,
            status: String(egressInfo.status || 'EGRESS_STARTING'),
            egressUrl: context.egressUrl,
            egressId: egressInfo.egress_id || '',
            filePath: outputFilePath,
            egressInfo,
            startedAt: nowIso(),
            createdAt: nowIso(),
            stoppedAt: null
        };
        payload.recordings.push(recording);
        recordMeetingEvent(context, meetingId, payload, 'recording.started', { meetingId, recordingId: recording.id, egressId: recording.egressId, filePath: recording.filePath });
    });
    return recording;
}

export async function stopMeetingRecording(context, meetingId) {
    let recording = null;
    let artifact = null;
    let egressResponse = null;
    const payloadSnapshot = decryptMeetingPayload(context, loadMeetingRecord(context, meetingId));
    const activeRecording = [...payloadSnapshot.recordings].reverse().find((entry) => entry.meetingId === meetingId && ACTIVE_RECORDING_STATUSES.has(String(entry.status || ''))) || null;
    if (!activeRecording) throw new Error('Active recording not found.');
    if (activeRecording.egressId) {
        egressResponse = await callEgressApi(context, 'StopEgress', {
            egress_id: activeRecording.egressId
        });
    }
    mutateMeeting(context, meetingId, (_record, payload) => {
        recording = [...payload.recordings].reverse().find((entry) => entry.meetingId === meetingId && ACTIVE_RECORDING_STATUSES.has(String(entry.status || ''))) || null;
        if (!recording) throw new Error('Active recording not found.');
        recording.status = String(egressResponse?.status || 'EGRESS_COMPLETE');
        recording.stoppedAt = nowIso();
        recording.egressStopInfo = egressResponse || null;
        artifact = {
            id: randomId('artifact'),
            meetingId,
            type: 'recording',
            title: `Recording ${recording.id}`,
            body: [
                `room=${recording.roomName}`,
                `file=${recording.filePath}`,
                `egressId=${recording.egressId || 'n/a'}`,
                `status=${recording.status}`,
                `startedAt=${recording.startedAt || recording.createdAt || ''}`,
                `stoppedAt=${recording.stoppedAt || ''}`
            ].join('\n'),
            createdAt: nowIso()
        };
        payload.artifacts.push(artifact);
        recordMeetingEvent(context, meetingId, payload, 'recording.stopped', { meetingId, recordingId: recording.id, egressId: recording.egressId, filePath: recording.filePath });
        recordMeetingEvent(context, meetingId, payload, 'artifact.created', { meetingId, artifactId: artifact.id });
    });
    return { recording, artifact };
}

export function listMeetingArtifacts(context, meetingId) {
    const payload = decryptMeetingPayload(context, loadMeetingRecord(context, meetingId));
    return { artifacts: payload.artifacts, tasks: payload.tasks, decisions: payload.decisions, recordings: payload.recordings };
}

export async function closeMeeting(context, meetingId) {
    const initialRecord = loadMeetingRecord(context, meetingId);
    const initialPayload = decryptMeetingPayload(context, initialRecord);
    const hasScribe = initialPayload.agents.some((entry) => entry.agentType === 'scribe' && entry.mode === 'post_event');
    if (hasScribe) {
        const job = enqueueJob(context.workspaceRoot, 'scribe_finalize', { meetingId });
        const completed = await waitForJob(context.workspaceRoot, job.id, 20000);
        return completed.result;
    }
    let artifact = null;
    let meeting = null;
    mutateMeeting(context, meetingId, (record, payload) => {
        record.status = 'closed';
        record.closedAt = nowIso();
        artifact = summarizeMeetingPayload(payload, record.title, record.closedAt);
        payload.artifacts.push(artifact);
        recordMeetingEvent(context, meetingId, payload, 'meeting.ended', { meetingId });
        recordMeetingEvent(context, meetingId, payload, 'artifact.created', { meetingId, artifactId: artifact.id });
        meeting = buildMeetingView(record);
    });
    const payload = decryptMeetingPayload(context, loadMeetingRecord(context, meetingId));
    return { meeting, artifact, tasks: payload.tasks, decisions: payload.decisions };
}
