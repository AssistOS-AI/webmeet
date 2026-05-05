import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';
import { resolveVarValue } from './secretVars.mjs';
import { createWrappedDek, decryptPayload, deriveMasterKey, encryptPayload, unwrapDek } from './webmeetCrypto.mjs';
import { generateAssistantReply, generateObserverSummary, generateScribeOutput } from './webmeetLLM.mjs';
import { appendEventLog, enqueueJob, waitForJob } from './webmeetQueue.mjs';

const MASTER_KEY_VAR = 'PLOINKY_WEBMEET_MASTER_KEY';
const RETENTION_DAYS_VAR = 'PLOINKY_WEBMEET_RETENTION_DAYS';
const PRESENCE_TTL_MS_VAR = 'PLOINKY_WEBMEET_PRESENCE_TTL_MS';
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const DEFAULT_ROOM_TITLE = 'General';
const DEFAULT_STUN_URLS = [
    'stun:global.stun.twilio.com:3478',
    'stun:stun.l.google.com:19302',
    'stun:stun1.l.google.com:19302'
];
const ACTIVE_RECORDING_STATUSES = new Set([
    'recording',
    'EGRESS_STARTING',
    'EGRESS_ACTIVE',
    'EGRESS_LIMIT_REACHED'
]);

function nowIso() {
    return new Date().toISOString();
}

function toTimestamp(value) {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function normalizeAuthInfo(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') {
        return {
            id: '',
            username: '',
            email: '',
            principalId: '',
            roles: []
        };
    }
    const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const agent = authInfo.agent && typeof authInfo.agent === 'object' ? authInfo.agent : null;
    return {
        id: String(user.id || '').trim(),
        username: String(user.username || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(agent?.principalId || authInfo.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
}

export function isAdminAuthInfo(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    const roleMatch = normalized.roles.some((role) => String(role || '').trim().toLowerCase() === 'admin');
    if (roleMatch) {
        return true;
    }
    return normalized.username.toLowerCase() === 'admin'
        || normalized.id === 'local:admin'
        || normalized.principalId === 'user:local:admin';
}

function assertAdminAuthInfo(authInfo = null) {
    if (!isAdminAuthInfo(authInfo)) {
        throw new Error('Access denied: only admin can manage rooms.');
    }
}

function getAuthDisplayName(authInfo = null) {
    const user = authInfo && typeof authInfo === 'object'
        ? (authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo)
        : null;
    if (!user) return '';
    return String(user.name || user.username || user.email || '').trim();
}

function canViewMeetingRecord(record, authInfo = null) {
    return String(record?.status || '').trim().toLowerCase() !== 'closed';
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
        raw = String(process.env.PLOINKY_MASTER_KEY || process.env.PLOINKY_WIRE_SECRET || '').trim();
    }
    if (!raw) {
        throw new Error(`${MASTER_KEY_VAR} is not configured.`);
    }
    return deriveMasterKey(raw);
}

function getPresenceTtlMs(workspaceRoot) {
    const raw = readConfigValue(workspaceRoot, PRESENCE_TTL_MS_VAR);
    const parsed = parseInt(raw || '', 10);
    if (Number.isFinite(parsed) && parsed >= 1_000) {
        return parsed;
    }
    return DEFAULT_PRESENCE_TTL_MS;
}

function filePathFor(dir, id) {
    return path.join(dir, `${id}.json`);
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, record) {
    // Atomic write: temp + rename. Concurrent webmeet tool subprocesses run
    // cleanupMeetingPresence on the same record, and a non-atomic in-place
    // writeFileSync gave parallel readers an empty/truncated file mid-write,
    // surfacing as "Unexpected end of JSON input" / MCP -32603 in the UI.
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tempPath, filePath);
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
                const meetingId = String(record?.meetingId || path.basename(filePath, '.json')).trim();
                if (meetingId) {
                    fs.rmSync(path.join(paths.eventsDir, meetingId), { recursive: true, force: true });
                }
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
    try {
        return readJsonFile(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('Meeting not found.');
        }
        throw error;
    }
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

function cleanupStaleMembers(context, meetingId, payload) {
    const now = Date.now();
    const ttlMs = getPresenceTtlMs(context.workspaceRoot);
    const members = Array.isArray(payload.members) ? payload.members : [];
    const kept = [];
    const removed = [];
    for (const member of members) {
        const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
        if (!lastSeenAt || (now - lastSeenAt) > ttlMs) {
            removed.push(member);
            continue;
        }
        kept.push(member);
    }
    if (removed.length > 0) {
        payload.members = kept;
        for (const member of removed) {
            const participantId = String(member?.id || '').trim();
            if (!participantId) continue;
            recordMeetingEvent(context, meetingId, payload, 'participant.timed_out', {
                meetingId,
                participantId
            });
        }
    }
    return removed;
}

function cleanupMeetingPresence(context, meetingId) {
    let removedCount = 0;
    mutateMeeting(context, meetingId, (_record, payload) => {
        removedCount = cleanupStaleMembers(context, meetingId, payload).length;
    });
    return removedCount;
}

function cleanupWorkspaceMeetingsPresence(context, workspaceId) {
    for (const filePath of listJsonFiles(context.meetingsDir)) {
        try {
            const record = readJsonFile(filePath);
            if (String(record?.workspaceId || '') !== String(workspaceId || '')) continue;
            cleanupMeetingPresence(context, String(record?.meetingId || ''));
        } catch (_) {
            // ignore malformed entries
        }
    }
}

function buildRoomName(prefix, workspaceId, meetingId) {
    return `${prefix}-${workspaceId}-${meetingId}`
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 160);
}

function splitCsvEnv(value) {
    return String(value || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function normalizeTurnHost(value) {
    return String(value || '')
        .trim()
        .replace(/^turns?:\/\//i, '')
        .replace(/^turns?:/i, '')
        .replace(/\?.*$/u, '')
        .replace(/\/+$/u, '');
}

function buildTurnUrls({ host, port, explicitUrls }) {
    const urls = splitCsvEnv(explicitUrls);
    if (urls.length) {
        return urls;
    }
    const normalizedHost = normalizeTurnHost(host);
    if (!normalizedHost) {
        return [];
    }
    const safePort = String(port || '3478').trim() || '3478';
    const hostWithPort = /:\d+$/u.test(normalizedHost) ? normalizedHost : `${normalizedHost}:${safePort}`;
    return [
        `turn:${hostWithPort}?transport=udp`,
        `turn:${hostWithPort}?transport=tcp`
    ];
}

function buildRtcConfig(context) {
    const turn = context.turn || {};
    const username = String(turn.username || '').trim();
    const credential = String(turn.credential || '').trim();
    const turnUrls = buildTurnUrls(turn);
    if (!username || !credential || !turnUrls.length) {
        return null;
    }
    const iceTransportPolicy = String(turn.iceTransportPolicy || '').trim();
    return {
        iceTransportPolicy: iceTransportPolicy === 'relay' ? 'relay' : 'all',
        iceServers: [
            { urls: DEFAULT_STUN_URLS },
            {
                urls: turnUrls,
                username,
                credential
            }
        ]
    };
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
        roomType: record.roomType || 'team',
        roomName: record.roomName,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        closedAt: record.closedAt || null
    };
}

export function getMeeting(context, meetingId, authInfo = null) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptMeetingPayload(context, record);
    const meeting = buildMeetingView(record);
    if (isAdminAuthInfo(authInfo) && record.roomType === 'guest') {
        meeting.guestToken = record.guestToken || '';
    }
    return {
        meeting,
        participants: payload.members,
        agents: payload.agents,
        observerState: payload.observerState,
        recordings: payload.recordings
    };
}

export function buildMeetingAiContext(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
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
        recordingsDir: String(process.env.WEBMEET_RECORDINGS_DIR || '/recordings').trim() || '/recordings',
        turn: {
            host: String(process.env.WEBMEET_TURN_EXTERNAL_IP || '').trim(),
            port: String(process.env.WEBMEET_TURN_PORT || '').trim(),
            explicitUrls: String(process.env.WEBMEET_TURN_URLS || '').trim(),
            username: String(process.env.WEBMEET_TURN_USER || '').trim(),
            credential: String(process.env.WEBMEET_TURN_PASSWORD || '').trim(),
            iceTransportPolicy: String(process.env.WEBMEET_ICE_TRANSPORT_POLICY || '').trim()
        }
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

function createMeetingRecord(context, effectiveWorkspaceId, title, roomType = 'team') {
    const meetingId = randomId('meeting');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + getRetentionDays(context.workspaceRoot) * 24 * 60 * 60 * 1000).toISOString();
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const { wrapped, dek } = createWrappedDek(masterKey);
    const payload = createMeetingPayload();
    recordMeetingEvent(context, meetingId, payload, 'meeting.created', { meetingId, roomType });

    const isGuestRoom = roomType === 'guest';
    const guestToken = isGuestRoom ? crypto.randomUUID() : null;

    const record = {
        version: 1,
        meetingId,
        workspaceId: effectiveWorkspaceId,
        title,
        roomType: isGuestRoom ? 'guest' : 'team',
        roomName: buildRoomName(context.roomPrefix, effectiveWorkspaceId, meetingId),
        guestToken,
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        closedAt: null,
        expiresAt,
        dek: wrapped,
        payload: encryptPayload(dek, payload)
    };
    writeJsonFile(filePathFor(context.meetingsDir, meetingId), record);
    return record;
}

function ensureDefaultMeeting(context, workspaceId) {
    const records = listJsonFiles(context.meetingsDir)
        .map(readJsonFile)
        .filter((entry) => entry.workspaceId === workspaceId);
    const hasActiveMeeting = records.some((entry) => String(entry?.status || '').trim().toLowerCase() === 'active');
    if (hasActiveMeeting) {
        return null;
    }
    return createMeetingRecord(context, workspaceId, DEFAULT_ROOM_TITLE, 'team');
}

export function listMeetings(context, workspaceId, authInfo = null) {
    const workspace = ensureCurrentWorkspaceRecord(context);
    const effectiveWorkspaceId = String(workspaceId || '').trim() || workspace.id;
    const canManageRooms = isAdminAuthInfo(authInfo);
    cleanupWorkspaceMeetingsPresence(context, effectiveWorkspaceId);
    return listJsonFiles(context.meetingsDir).map((filePath) => {
        try {
            return readJsonFile(filePath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }).filter((entry) => entry && (
        entry.workspaceId === effectiveWorkspaceId && canViewMeetingRecord(entry, authInfo)
    )).map((entry) => ({
        id: entry.meetingId,
        workspaceId: entry.workspaceId,
        title: entry.title,
        roomType: entry.roomType || 'team',
        guestToken: canManageRooms && entry.roomType === 'guest' ? entry.guestToken : undefined,
        roomName: entry.roomName,
        status: entry.status,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        closedAt: entry.closedAt || null
    }));
}

export function updateMeetingTitle(context, { meetingId, title, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const nextTitle = String(title || '').trim();
    if (!nextTitle) {
        throw new Error('Missing room title.');
    }
    let meeting = null;
    mutateMeeting(context, meetingId, (record, payload) => {
        record.title = nextTitle;
        meeting = buildMeetingView(record);
        recordMeetingEvent(context, meetingId, payload, 'meeting.renamed', {
            meetingId,
            title: nextTitle
        });
    });
    return meeting;
}

export function createMeeting(context, { workspaceId, title, roomType = 'team', authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const workspace = ensureCurrentWorkspaceRecord(context);
    const effectiveWorkspaceId = String(workspaceId || '').trim() || workspace.id;
    if (effectiveWorkspaceId !== workspace.id) {
        throw new Error('Workspace mismatch for current Explorer workspace.');
    }
    const validRoomType = roomType === 'guest' ? 'guest' : 'team';
    const record = createMeetingRecord(context, effectiveWorkspaceId, title, validRoomType);
    return {
        id: record.meetingId,
        workspaceId: record.workspaceId,
        title: record.title,
        roomType: record.roomType,
        roomName: record.roomName,
        guestToken: record.guestToken,
        status: record.status,
        createdAt: record.createdAt,
        closedAt: record.closedAt
    };
}

export function joinGuestMeeting(context, { meetingId, guestToken, displayName, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || 'Guest').trim() || 'Guest';
    const joinedAt = nowIso();

    let participant = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        const members = Array.isArray(payload.members) ? payload.members : [];
        payload.members = members;
        participant = members.find((p) => p.id === participantIdentity);
        if (!participant) {
            participant = { id: participantIdentity, displayName: effectiveDisplayName, joinedAt, lastSeenAt: joinedAt, guest: true };
            members.push(participant);
        } else {
            participant.displayName = effectiveDisplayName;
            participant.lastSeenAt = joinedAt;
            participant.guest = true;
        }
        recordMeetingEvent(context, meetingId, payload, 'participant.joined', { meetingId, participantId: participantIdentity, guest: true });
    });

    return {
        meeting: {
            id: record.meetingId,
            workspaceId: record.workspaceId,
            title: record.title,
            roomType: record.roomType || 'guest',
            roomName: record.roomName,
            status: record.status,
            createdAt: record.createdAt,
            closedAt: record.closedAt || null
        },
        participant,
        livekitUrl: context.livekitPublicUrl,
        roomName: record.roomName,
        participantToken: createLiveKitToken(context, { roomName: record.roomName, identity: participant.id, name: effectiveDisplayName }),
        participantIdentity: participant.id
    };
}

function assertGuestMeetingAccess(record, guestToken) {
    if (record.roomType !== 'guest') {
        throw new Error('Meeting does not support guest access.');
    }
    if (!canViewMeetingRecord(record, null)) {
        throw new Error('Meeting not found.');
    }
    if (String(record.guestToken || '').trim() !== String(guestToken || '').trim()) {
        throw new Error('Invalid guest token.');
    }
}

function assertGuestParticipant(payload, participantId) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    const participant = (Array.isArray(payload.members) ? payload.members : []).find((entry) => (
        String(entry?.id || '').trim() === targetParticipantId && entry?.guest === true
    )) || null;
    if (!participant) {
        throw new Error('Guest participant is not joined.');
    }
    return participant;
}

export function getGuestMeetingDetails(context, { meetingId, guestToken, participantId }) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return {
        meeting: buildMeetingView(record),
        participants: payload.members,
        chat: payload.chatMessages,
        transcript: payload.transcriptSegments,
        artifacts: payload.artifacts,
        recordings: payload.recordings,
        tasks: payload.tasks,
        decisions: payload.decisions,
        agents: payload.agents,
        observerState: payload.observerState
    };
}

export function pingGuestMeetingPresence(context, { meetingId, guestToken, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return pingMeetingPresence(context, { meetingId, participantId });
}

export function leaveGuestMeeting(context, { meetingId, guestToken, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return leaveMeeting(context, { meetingId, participantId });
}

export function joinMeeting(context, { meetingId, displayName, participantId, authInfo = null }) {
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || getAuthDisplayName(authInfo) || 'Participant').trim() || 'Participant';
    const joinedAt = nowIso();
    let participant = null;
    const { record } = mutateMeeting(context, meetingId, (_record, payload) => {
        cleanupStaleMembers(context, meetingId, payload);
        participant = payload.members.find((entry) => entry.id === participantIdentity) || null;
        if (!participant) {
            participant = { id: participantIdentity, displayName: effectiveDisplayName, joinedAt, lastSeenAt: joinedAt };
            payload.members.push(participant);
            recordMeetingEvent(context, meetingId, payload, 'participant.joined', { meetingId, participantId: participant.id });
        } else {
            participant.displayName = effectiveDisplayName;
            if (!participant.joinedAt) {
                participant.joinedAt = joinedAt;
            }
            participant.lastSeenAt = joinedAt;
        }
    });
    const rtcConfig = buildRtcConfig(context);
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
        participantToken: createLiveKitToken(context, { roomName: record.roomName, identity: participant.id, name: effectiveDisplayName }),
        participantIdentity: participant.id,
        ...(rtcConfig ? { rtcConfig } : {})
    };
}

export function leaveMeeting(context, { meetingId, participantId }) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        const existingMembers = Array.isArray(payload.members) ? payload.members : [];
        const nextMembers = existingMembers.filter((entry) => {
            const sameParticipant = String(entry?.id || '').trim() === targetParticipantId;
            if (sameParticipant && !removedParticipant) {
                removedParticipant = entry;
            }
            return !sameParticipant;
        });
        payload.members = nextMembers;
        if (removedParticipant) {
            recordMeetingEvent(context, meetingId, payload, 'participant.left', {
                meetingId,
                participantId: targetParticipantId
            });
        }
    });
    return {
        ok: true,
        removed: Boolean(removedParticipant),
        participantId: targetParticipantId
    };
}

export function pingMeetingPresence(context, { meetingId, participantId }) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    const pingAt = nowIso();
    let touched = false;
    mutateMeeting(context, meetingId, (_record, payload) => {
        cleanupStaleMembers(context, meetingId, payload);
        const participant = (Array.isArray(payload.members) ? payload.members : []).find((entry) => (
            String(entry?.id || '').trim() === targetParticipantId
        )) || null;
        if (!participant) return;
        participant.lastSeenAt = pingAt;
        touched = true;
    });
    return {
        ok: true,
        touched,
        participantId: targetParticipantId,
        lastSeenAt: pingAt
    };
}

export function listMeetingChat(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).chatMessages;
}

export async function appendMeetingChat(context, { meetingId, authorId, authorName, message }) {
    cleanupMeetingPresence(context, meetingId);
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

export async function appendGuestMeetingChat(context, { meetingId, guestToken, participantId, message }) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    const participant = assertGuestParticipant(payload, participantId);
    return appendMeetingChat(context, {
        meetingId,
        authorId: participant.id,
        authorName: participant.displayName || 'Guest',
        message
    });
}

export async function appendMeetingTranscript(context, { meetingId, speakerId, speakerName, text }) {
    cleanupMeetingPresence(context, meetingId);
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

export async function appendGuestMeetingTranscript(context, { meetingId, guestToken, participantId, text }) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    const participant = assertGuestParticipant(payload, participantId);
    return appendMeetingTranscript(context, {
        meetingId,
        speakerId: participant.id,
        speakerName: participant.displayName || 'Guest',
        text
    });
}

export function listMeetingTranscript(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).transcriptSegments;
}

export function attachMeetingAgent(context, { meetingId, agentType, mode }) {
    cleanupMeetingPresence(context, meetingId);
    let agent = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        agent = { id: randomId('agent'), meetingId, agentType, mode, createdAt: nowIso() };
        payload.agents.push(agent);
    });
    return agent;
}

export function listMeetingAgents(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).agents;
}

export async function startMeetingRecording(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
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
    cleanupMeetingPresence(context, meetingId);
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
    cleanupMeetingPresence(context, meetingId);
    const payload = decryptMeetingPayload(context, loadMeetingRecord(context, meetingId));
    return { artifacts: payload.artifacts, tasks: payload.tasks, decisions: payload.decisions, recordings: payload.recordings };
}

export function deleteMeeting(context, meetingId, authInfo = null) {
    assertAdminAuthInfo(authInfo);
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Meeting not found.');
    }
    const record = loadMeetingRecord(context, targetMeetingId);
    fs.rmSync(path.join(context.eventsDir, targetMeetingId), { recursive: true, force: true });
    fs.rmSync(filePathFor(context.meetingsDir, targetMeetingId), { force: true });
    return {
        ok: true,
        meeting: buildMeetingView(record)
    };
}
