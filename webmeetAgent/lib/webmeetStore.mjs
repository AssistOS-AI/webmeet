import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';
import { resolveVarValue } from './secretVars.mjs';
import { createWrappedDek, decryptPayload, deriveMasterKey, encryptPayload, unwrapDek } from './webmeetCrypto.mjs';
import { appendEventLog, appendWorkspaceEventLog } from './webmeetQueue.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    getWebMeetEventId,
    isWorkspacePersistentWebMeetEvent
} from '../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

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
const pendingEmptyRoomAgentDetachments = new Set();

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
    const raw = readConfigValue(workspaceRoot, MASTER_KEY_VAR);
    if (!raw) {
        throw new Error(`${MASTER_KEY_VAR} is not configured.`);
    }
    return deriveMasterKey(raw);
}

function getLegacyMeetingKeyCandidates() {
    const raw = String(process.env.PLOINKY_DERIVED_MASTER_KEY || '').trim();
    if (!raw) {
        return [];
    }
    return [{
        source: 'legacy:PLOINKY_DERIVED_MASTER_KEY',
        key: deriveMasterKey(raw)
    }];
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
        decisions: []
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

function openMeetingPayload(context, record) {
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const candidates = [
        { source: MASTER_KEY_VAR, key: masterKey },
        ...getLegacyMeetingKeyCandidates()
    ];
    let firstError = null;
    for (const candidate of candidates) {
        try {
            const dek = unwrapDek(candidate.key, record.dek);
            const payload = decryptPayload(dek, record.payload);
            return {
                dek,
                payload,
                usedLegacyKey: candidate.source !== MASTER_KEY_VAR,
                source: candidate.source
            };
        } catch (error) {
            firstError = firstError || error;
        }
    }
    throw firstError || new Error('Unable to decrypt meeting payload.');
}

function decryptMeetingPayload(context, record) {
    return openMeetingPayload(context, record).payload;
}

function saveMeetingRecord(context, record, payload) {
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const opened = openMeetingPayload(context, record);
    if (opened.usedLegacyKey) {
        const { wrapped, dek } = createWrappedDek(masterKey);
        record.dek = wrapped;
        record.payload = encryptPayload(dek, payload);
        record.encryption = {
            masterKey: MASTER_KEY_VAR,
            migratedFrom: opened.source,
            migratedAt: nowIso()
        };
    } else {
        record.payload = encryptPayload(opened.dek, payload);
        record.encryption = {
            ...(record.encryption && typeof record.encryption === 'object' ? record.encryption : {}),
            masterKey: MASTER_KEY_VAR
        };
    }
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

function createMeetingEvent(meetingId, type, data = {}) {
    return buildWebMeetEvent(meetingId, type, {
        ...data,
        meetingId: String(data?.meetingId || meetingId || '').trim()
    });
}

function recordMeetingEvent(context, meetingId, _payload, type, data = {}) {
    const event = createMeetingEvent(meetingId, type, data);
    appendEventLog(context.workspaceRoot, meetingId, event);
    if (isWorkspacePersistentWebMeetEvent(type)) {
        try {
            const record = loadMeetingRecord(context, meetingId);
            if (record?.workspaceId) {
                appendWorkspaceEventLog(context.workspaceRoot, record.workspaceId, event);
            }
        } catch (_) {
            // Meeting creation records workspace events after the meeting file exists.
        }
    }
    return event;
}

function recordWorkspaceEvent(context, workspaceId, type, data = {}) {
    const event = buildWebMeetEvent(workspaceId, type, {
        ...data,
        workspaceId: String(data?.workspaceId || workspaceId || '').trim()
    });
    appendWorkspaceEventLog(context.workspaceRoot, workspaceId, event);
    return event;
}

function isActiveMeetingAgent(agent) {
    const status = String(agent?.status || '').trim().toLowerCase();
    return Boolean(agent)
        && !agent.deletedAt
        && status !== 'detached'
        && status !== 'stopped';
}

function hasHumanMeetingMembers(payload) {
    return Array.isArray(payload?.members) && payload.members.length > 0;
}

function markActiveAgentsDetached(context, meetingId, reason) {
    const detachedAgents = [];
    mutateMeeting(context, meetingId, (_record, payload) => {
        if (hasHumanMeetingMembers(payload)) return;
        const activeAgents = Array.isArray(payload.agents)
            ? payload.agents.filter(isActiveMeetingAgent)
            : [];
        for (const agent of activeAgents) {
            const detachedAt = nowIso();
            Object.assign(agent, {
                status: 'detached',
                deletedAt: detachedAt,
                updatedAt: detachedAt,
                detachReason: reason
            });
            detachedAgents.push({ ...agent });
            recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
                meetingId,
                agentId: agent.id || '',
                agentType: agent.agentType || '',
                mode: agent.mode || '',
                reason
            });
        }
    });
    return detachedAgents;
}

async function deleteLiveKitAgentDispatch(context, record, agent) {
    const dispatchId = String(agent?.dispatchId || '').trim();
    if (!dispatchId) return;
    try {
        await callLiveKitAgentDispatchApi(context, 'DeleteDispatch', record.roomName, {
            room: record.roomName,
            dispatchId
        });
    } catch {
        // Persisted metadata is still detached when LiveKit already removed the dispatch.
    }
}

async function detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, reason = 'no_human_participants') {
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    if (hasHumanMeetingMembers(payload)) {
        return [];
    }
    if (!Array.isArray(payload.agents) || !payload.agents.some(isActiveMeetingAgent)) {
        return [];
    }
    const detachedAgents = markActiveAgentsDetached(context, meetingId, reason);
    for (const agent of detachedAgents) {
        await deleteLiveKitAgentDispatch(context, record, agent);
    }
    return detachedAgents;
}

function scheduleEmptyRoomAgentDetach(context, meetingId, reason = 'no_human_participants') {
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId || pendingEmptyRoomAgentDetachments.has(targetMeetingId)) return;
    pendingEmptyRoomAgentDetachments.add(targetMeetingId);
    setTimeout(() => {
        detachActiveAgentsWhenRoomHasNoHumans(context, targetMeetingId, reason)
            .catch(() => {})
            .finally(() => {
                pendingEmptyRoomAgentDetachments.delete(targetMeetingId);
            });
    }, 0);
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
            recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT, {
                meetingId,
                participantId
            });
        }
        if (kept.length === 0) {
            scheduleEmptyRoomAgentDetach(context, meetingId, 'no_human_participants');
        }
    }
    return removed;
}

function cleanupMeetingPresence(context, meetingId) {
    let removedCount = 0;
    mutateMeeting(context, meetingId, (_record, payload) => {
        removedCount = cleanupStaleMembers(context, meetingId, payload).length;
        if (!hasHumanMeetingMembers(payload)) {
            scheduleEmptyRoomAgentDetach(context, meetingId, 'no_human_participants');
        }
    });
    return removedCount;
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

function sanitizeAvatarText(value, maxLength = 256) {
    return String(value ?? '').trim().slice(0, maxLength);
}

function sanitizeAvatarBoolean(value) {
    return value === true;
}

const AVATAR_ALLOWED_EMOTIONS = new Set([
    'neutral',
    'idle',
    'listening',
    'thinking',
    'speaking',
    'happy',
    'amused',
    'confused',
    'concerned',
    'alert',
    'sleepy'
]);
const AVATAR_ALLOWED_THOUGHT_MODES = new Set(['none', 'bubble', 'caption', 'ticker', 'inside']);
const AVATAR_ALLOWED_MODES = new Set(['static', 'controlled', 'event-driven', 'autonomous']);
const AVATAR_ALLOWED_SHAPES = new Set(['circle', 'square', 'rounded', 'none']);
const AVATAR_ALLOWED_THEMES = new Set(['light', 'dark', 'auto']);
const AVATAR_ALLOWED_ASSET_MODES = new Set(['img', 'inline']);
const AVATAR_ALLOWED_STYLES = new Set(['robot-soft', 'robot-minimal', 'sketch', 'emoji', 'terminal']);
const AVATAR_ALLOWED_COMPLEXITIES = new Set(['', 'low', 'minimal', 'medium', 'default', 'high', 'detailed']);
const AVATAR_CONFIG_FIELDS = new Set([
    'agentId',
    'src',
    'packSrc',
    'pack_src',
    'assetMode',
    'asset_mode',
    'emotion',
    'size',
    'thought',
    'thoughtMode',
    'thought_mode',
    'mode',
    'shape',
    'theme',
    'animated',
    'listen',
    'generated',
    'seed',
    'style',
    'axiStyle',
    'palette',
    'complexity'
]);

function sanitizeAvatarUrl(value, fieldName) {
    const raw = sanitizeAvatarText(value, 1024);
    if (!raw) return '';
    if (/[\u0000-\u001f]/.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: contains control characters.`);
    }
    if (/^(javascript|data):/i.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: unsafe URL scheme.`);
    }
    if (/^http:\/\//i.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: absolute URLs must use HTTPS.`);
    }
    if (/^\/\//.test(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: protocol-relative URLs are not allowed.`);
    }
    return raw;
}

function sanitizeAvatarEnum(value, allowed, fallback, fieldName) {
    const raw = sanitizeAvatarText(value, 64);
    if (!raw) return fallback;
    if (!allowed.has(raw)) {
        throw new Error(`Invalid participant avatar ${fieldName}: ${raw}`);
    }
    return raw;
}

function sanitizeAvatarSize(value) {
    const raw = sanitizeAvatarText(value || '72', 32);
    if (/^\d+(\.\d+)?$/.test(raw) || /^\d+(\.\d+)?(px|rem|em|vh|vw|vmin|vmax|%)$/.test(raw)) {
        return raw;
    }
    throw new Error(`Invalid participant avatar size: ${raw}`);
}

function sanitizeParticipantAvatarConfig(config = null, fallbackId = '') {
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
        return null;
    }
    for (const key of Object.keys(config)) {
        if (!AVATAR_CONFIG_FIELDS.has(key)) {
            throw new Error(`Unknown participant avatar config field: ${key}`);
        }
    }
    const fallback = sanitizeAvatarText(fallbackId || 'profile:participant', 128);
    const source = config;
    const complexity = sanitizeAvatarText(source.complexity, 64);
    if (!AVATAR_ALLOWED_COMPLEXITIES.has(complexity) && !/^(0(\.\d+)?|1(\.0+)?)$/.test(complexity)) {
        throw new Error(`Invalid participant avatar complexity: ${complexity}`);
    }
    return {
        agentId: sanitizeAvatarText(source.agentId || fallback, 128),
        generated: source.generated !== false,
        src: sanitizeAvatarUrl(source.src, 'src'),
        packSrc: sanitizeAvatarUrl(source.packSrc || source.pack_src, 'packSrc'),
        assetMode: sanitizeAvatarEnum(source.assetMode || source.asset_mode, AVATAR_ALLOWED_ASSET_MODES, 'img', 'assetMode'),
        emotion: sanitizeAvatarEnum(source.emotion, AVATAR_ALLOWED_EMOTIONS, 'neutral', 'emotion'),
        size: sanitizeAvatarSize(source.size),
        thought: sanitizeAvatarText(source.thought, 256),
        thoughtMode: sanitizeAvatarEnum(source.thoughtMode || source.thought_mode, AVATAR_ALLOWED_THOUGHT_MODES, source.thought ? 'bubble' : 'none', 'thoughtMode'),
        mode: sanitizeAvatarEnum(source.mode, AVATAR_ALLOWED_MODES, 'static', 'mode'),
        shape: sanitizeAvatarEnum(source.shape, AVATAR_ALLOWED_SHAPES, 'circle', 'shape'),
        theme: sanitizeAvatarEnum(source.theme, AVATAR_ALLOWED_THEMES, 'auto', 'theme'),
        animated: source.animated !== false,
        listen: sanitizeAvatarBoolean(source.listen),
        seed: sanitizeAvatarText(source.seed || source.agentId || fallback, 128),
        style: sanitizeAvatarEnum(source.style || source.axiStyle, AVATAR_ALLOWED_STYLES, 'robot-soft', 'style'),
        palette: sanitizeAvatarText(source.palette || 'default', 64),
        complexity
    };
}

function createDefaultParticipantAvatarConfig(fallbackId = '') {
    const fallback = sanitizeAvatarText(fallbackId || 'profile:participant', 128);
    return sanitizeParticipantAvatarConfig({
        agentId: fallback,
        seed: fallback,
        generated: true,
        assetMode: 'img',
        emotion: 'neutral',
        size: '72',
        thoughtMode: 'none',
        mode: 'static',
        shape: 'circle',
        theme: 'auto',
        animated: true,
        style: 'robot-soft',
        palette: 'default'
    }, fallback);
}

function sanitizeParticipantAvatarPayload(avatar = null, fallbackId = '') {
    if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) {
        return null;
    }
    const enabled = avatar.enabled !== false;
    const config = sanitizeParticipantAvatarConfig(avatar.config, fallbackId)
        || (enabled ? createDefaultParticipantAvatarConfig(fallbackId) : null);
    return {
        enabled,
        config,
        fallbackLetter: sanitizeAvatarText(avatar.fallbackLetter, 8),
        updatedAt: nowIso()
    };
}

function createLiveKitToken(context, { roomName, identity, name, attributes = null, metadata = '' }) {
    if (!context.livekitApiKey || !context.livekitApiSecret) {
        return null;
    }
    const participantAttributes = attributes && typeof attributes === 'object' ? attributes : {};
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: context.livekitApiKey,
        sub: identity,
        iat: now,
        nbf: now,
        exp: now + 60 * 60 * 8,
        name,
        ...(metadata ? { metadata } : {}),
        ...(Object.keys(participantAttributes).length ? { attributes: participantAttributes } : {}),
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

function createLiveKitRoomAdminToken(context, roomName) {
    if (!context.livekitApiKey || !context.livekitApiSecret) {
        return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        iss: context.livekitApiKey,
        sub: `${context.agentName || 'WebMeetAgent'}:dispatcher`,
        iat: now,
        nbf: now,
        exp: now + 60 * 10,
        video: {
            room: roomName,
            roomAdmin: true
        }
    })).toString('base64url');
    const signature = crypto
        .createHmac('sha256', context.livekitApiSecret)
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${signature}`;
}

function normalizeLiveKitHttpUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/g, '');
    if (!raw) return '';
    if (raw.startsWith('wss://')) return `https://${raw.slice(6)}`;
    if (raw.startsWith('ws://')) return `http://${raw.slice(5)}`;
    return raw;
}

async function callLiveKitAgentDispatchApi(context, methodName, roomName, body) {
    const baseUrl = normalizeLiveKitHttpUrl(context.livekitApiUrl);
    if (!baseUrl || !context.livekitApiKey || !context.livekitApiSecret) {
        throw new Error('LiveKit agent dispatch is not configured.');
    }
    const token = createLiveKitRoomAdminToken(context, roomName);
    if (!token) {
        throw new Error('LiveKit admin token could not be created.');
    }
    const response = await fetch(`${baseUrl}/twirp/livekit.AgentDispatchService/${methodName}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body || {})
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (!response.ok) {
        const detail = parsed?.msg || parsed?.message || text || `${response.status} ${response.statusText}`;
        throw new Error(`LiveKit agent dispatch failed: ${detail}`);
    }
    return parsed || {};
}

async function callLiveKitRoomApi(context, methodName, roomName, body) {
    const baseUrl = normalizeLiveKitHttpUrl(context.livekitApiUrl);
    if (!baseUrl || !context.livekitApiKey || !context.livekitApiSecret) {
        throw new Error('LiveKit room API is not configured.');
    }
    const token = createLiveKitRoomAdminToken(context, roomName);
    if (!token) {
        throw new Error('LiveKit admin token could not be created.');
    }
    const response = await fetch(`${baseUrl}/twirp/livekit.RoomService/${methodName}`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(body || {})
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (!response.ok) {
        const detail = parsed?.msg || parsed?.message || text || `${response.status} ${response.statusText}`;
        throw new Error(`LiveKit room API failed: ${detail}`);
    }
    return parsed || {};
}

function getAgentDispatchId(dispatch) {
    return String(dispatch?.id || dispatch?.dispatchId || dispatch?.dispatch_id || '').trim();
}

function getAgentDispatches(response) {
    const dispatches = response?.agentDispatches || response?.agent_dispatches || [];
    return Array.isArray(dispatches) ? dispatches : [];
}

function isDeletedLiveKitDispatch(dispatch) {
    const deletedAt = dispatch?.state?.deletedAt || dispatch?.state?.deleted_at || '0';
    return String(deletedAt || '0') !== '0';
}

function getParticipantAttributes(participant) {
    return participant?.attributes && typeof participant.attributes === 'object' ? participant.attributes : {};
}

function parseLiveKitProfileAvatar(attributes = {}) {
    const raw = String(attributes?.webmeetProfileAvatar || '').trim();
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : null;
    } catch {
        return null;
    }
}

function isMatchingLiveKitAgentParticipant(context, metadata, participant) {
    const attributes = getParticipantAttributes(participant);
    return String(participant?.kind || '').toUpperCase() === 'AGENT'
        && String(attributes.webmeetAgent || '').toLowerCase() === 'true'
        && String(attributes.webmeetAgentName || '') === String(context.livekitAgentName || '')
        && String(attributes.webmeetMeetingId || '') === String(metadata.meetingId || '')
        && String(attributes.webmeetAgentType || '') === String(metadata.agentType || '')
        && String(attributes.webmeetAgentMode || '') === String(metadata.mode || '');
}

async function getLiveKitAgentParticipant(context, roomName, metadata) {
    const response = await callLiveKitRoomApi(context, 'ListParticipants', roomName, { room: roomName });
    const participants = Array.isArray(response.participants) ? response.participants : [];
    return participants.find((participant) => isMatchingLiveKitAgentParticipant(context, metadata, participant)) || null;
}

function getLiveKitParticipantIdentity(participant) {
    return String(participant?.identity || '').trim();
}

function isLiveKitAgentParticipant(participant) {
    const attributes = getParticipantAttributes(participant);
    return String(participant?.kind || '').toUpperCase() === 'AGENT'
        || String(attributes.webmeetAgent || '').toLowerCase() === 'true';
}

async function listLiveKitRoomParticipants(context, roomName) {
    if (typeof context.listLiveKitParticipants === 'function') {
        const participants = await context.listLiveKitParticipants(roomName);
        return Array.isArray(participants) ? participants : [];
    }
    const response = await callLiveKitRoomApi(context, 'ListParticipants', roomName, { room: roomName });
    return Array.isArray(response.participants) ? response.participants : [];
}

function projectLiveKitMeetingParticipants(payload, liveParticipants) {
    const now = nowIso();
    const cachedMembers = Array.isArray(payload?.members) ? payload.members : [];
    const cachedById = new Map(cachedMembers.map((member) => [String(member?.id || '').trim(), member]).filter(([id]) => id));
    const projected = [];
    for (const liveParticipant of Array.isArray(liveParticipants) ? liveParticipants : []) {
        if (isLiveKitAgentParticipant(liveParticipant)) continue;
        const participantId = getLiveKitParticipantIdentity(liveParticipant);
        if (!participantId) continue;
        const cached = cachedById.get(participantId) || {};
        const liveAttributes = getParticipantAttributes(liveParticipant);
        projected.push({
            ...cached,
            id: participantId,
            displayName: String(liveParticipant?.name || cached.displayName || participantId).trim() || participantId,
            joinedAt: cached.joinedAt || now,
            lastSeenAt: now,
            pendingLiveKit: false,
            profileAvatar: parseLiveKitProfileAvatar(liveAttributes),
            attributes: {
                ...(cached.attributes && typeof cached.attributes === 'object' ? cached.attributes : {}),
                ...liveAttributes
            }
        });
    }
    return projected;
}

function shouldPreserveStoredMemberDuringReconcile(context, member) {
    if (member?.pendingLiveKit !== true) {
        return false;
    }
    const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
    if (!lastSeenAt) {
        return false;
    }
    return (Date.now() - lastSeenAt) <= getPresenceTtlMs(context.workspaceRoot);
}

function syncPayloadMembersToLiveKitParticipants(context, record, payload, participants) {
    const currentMembers = Array.isArray(payload.members) ? payload.members : [];
    const preservedMembers = currentMembers.filter((member) => {
        const participantId = String(member?.id || '').trim();
        if (!participantId) {
            return false;
        }
        if (participants.some((entry) => String(entry?.id || '').trim() === participantId)) {
            return false;
        }
        return shouldPreserveStoredMemberDuringReconcile(context, member);
    });
    const nextParticipants = [...participants, ...preservedMembers];
    const currentIds = new Set(currentMembers.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const nextIds = new Set(nextParticipants.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const membershipChanged = currentIds.size !== nextIds.size
        || [...currentIds].some((participantId) => !nextIds.has(participantId));

    payload.members = nextParticipants.map((member) => {
        const attributes = member?.attributes && typeof member.attributes === 'object'
            ? member.attributes
            : {};
        const {
            webmeetProfileAvatar: _webmeetProfileAvatar,
            ...durableAttributes
        } = attributes;
        const { profileAvatar: _profileAvatar, ...durableMember } = member || {};
        return {
            ...durableMember,
            ...(Object.keys(durableAttributes).length ? { attributes: durableAttributes } : {})
        };
    });
    if (membershipChanged) {
        for (const member of currentMembers) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || nextIds.has(participantId)) continue;
            recordMeetingEvent(context, record.meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId: record.meetingId,
                participantId,
                reason: 'livekit_reconcile'
            });
        }
        for (const member of participants) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || currentIds.has(participantId)) continue;
            recordMeetingEvent(context, record.meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
                meetingId: record.meetingId,
                participantId,
                source: 'livekit_reconcile'
            });
        }
    }
    saveMeetingRecord(context, record, payload);
    return nextParticipants;
}

function projectStoredMeetingParticipants(payload) {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    return members
        .map((member) => ({
            ...member,
            id: String(member?.id || '').trim(),
            displayName: String(member?.displayName || member?.id || 'Participant').trim() || 'Participant'
        }))
        .filter((member) => member.id);
}

async function getRealtimeMeetingParticipants(context, record, payload, options = {}) {
    const liveParticipants = await listLiveKitRoomParticipants(context, record.roomName);
    if (options.preserveStoredMembersOnEmpty === true && liveParticipants.length === 0) {
        return projectStoredMeetingParticipants(payload);
    }
    const participants = projectLiveKitMeetingParticipants(payload, liveParticipants);
    const reconciledParticipants = syncPayloadMembersToLiveKitParticipants(context, record, payload, participants);
    if (reconciledParticipants.length === 0) {
        scheduleEmptyRoomAgentDetach(context, record.meetingId, 'no_human_participants');
    }
    return reconciledParticipants;
}

async function waitForLiveKitAgentDispatch(context, roomName, dispatchId, metadata) {
    if (!dispatchId) {
        throw new Error('LiveKit dispatch response did not include a dispatch id.');
    }
    const deadline = Date.now() + 10_000;
    let latest = null;
    let participant = null;
    while (Date.now() < deadline) {
        const response = await callLiveKitAgentDispatchApi(context, 'ListDispatch', roomName, {
            room: roomName,
            dispatchId
        });
        const dispatches = getAgentDispatches(response);
        latest = dispatches[0] || latest;
        participant = await getLiveKitAgentParticipant(context, roomName, metadata);
        if (latest && !isDeletedLiveKitDispatch(latest) && participant) {
            return {
                dispatch: latest,
                participant
            };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    try {
        await callLiveKitAgentDispatchApi(context, 'DeleteDispatch', roomName, {
            room: roomName,
            dispatchId
        });
    } catch {
        // Keep the original dispatch failure as the user-facing error.
    }
    throw new Error('LiveKit agent runtime did not accept the dispatch.');
}

async function getLiveKitAgentDispatch(context, roomName, dispatchId) {
    if (!dispatchId) {
        return null;
    }
    const response = await callLiveKitAgentDispatchApi(context, 'ListDispatch', roomName, {
        room: roomName,
        dispatchId
    });
    const dispatches = getAgentDispatches(response);
    return dispatches[0] || null;
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

export async function getMeeting(context, meetingId, authInfo = null) {
    const record = loadMeetingRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptMeetingPayload(context, record);
    const participants = await getRealtimeMeetingParticipants(context, record, payload);
    const meeting = buildMeetingView(record);
    if (isAdminAuthInfo(authInfo) && record.roomType === 'guest') {
        meeting.guestToken = record.guestToken || '';
    }
    return {
        meeting,
        participants,
        agents: payload.agents,
        recordings: payload.recordings
    };
}

export function listMeetingEvents(context, meetingId, { afterId = '' } = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId) return [];
    const eventsDir = path.join(context.eventsDir, targetMeetingId);
    if (!fs.existsSync(eventsDir)) return [];
    const afterEventId = String(afterId || '').trim();
    let foundAfter = !afterEventId;
    return fs.readdirSync(eventsDir)
        .filter((name) => name.endsWith('.event'))
        .sort()
        .map((name) => {
            try {
                return fs.readFileSync(path.join(eventsDir, name), 'utf8').trim();
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean)
        .filter((event) => {
            const eventId = getWebMeetEventId(event);
            if (!afterEventId) return true;
            if (foundAfter) return true;
            if (eventId === afterEventId) {
                foundAfter = true;
            }
            return false;
        })
        .filter((event) => getWebMeetEventId(event) !== afterEventId);
}

export function listWorkspaceEvents(context, workspaceId, { afterId = '' } = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) return [];
    const eventsDir = path.join(context.eventsDir, 'workspaces', targetWorkspaceId);
    if (!fs.existsSync(eventsDir)) return [];
    const afterEventId = String(afterId || '').trim();
    let foundAfter = !afterEventId;
    return fs.readdirSync(eventsDir)
        .filter((name) => name.endsWith('.event'))
        .sort()
        .map((name) => {
            try {
                return fs.readFileSync(path.join(eventsDir, name), 'utf8').trim();
            } catch (_) {
                return null;
            }
        })
        .filter(Boolean)
        .filter((event) => {
            const eventId = getWebMeetEventId(event);
            if (!afterEventId) return true;
            if (foundAfter) return true;
            if (eventId === afterEventId) {
                foundAfter = true;
            }
            return false;
        })
        .filter((event) => getWebMeetEventId(event) !== afterEventId);
}

export function recordProfileAvatarUpdated(context, {
    workspaceId,
    userId,
    authInfo = null
} = {}) {
    const targetWorkspaceId = String(workspaceId || '').trim();
    if (!targetWorkspaceId) {
        throw new Error('Missing workspace id.');
    }
    listMeetings(context, targetWorkspaceId, authInfo);
    const normalizedAuth = normalizeAuthInfo(authInfo);
    const targetUserId = String(userId || normalizedAuth.id || '').trim();
    if (!targetUserId) {
        throw new Error('Missing profile avatar user id.');
    }
    if (!isAdminAuthInfo(authInfo) && normalizedAuth.id && normalizedAuth.id !== targetUserId) {
        throw new Error('Access denied: cannot publish another user profile avatar update.');
    }
    return recordWorkspaceEvent(context, targetWorkspaceId, WEBMEET_EVENT_TYPES.PROFILE_AVATAR_UPDATED, {
        workspaceId: targetWorkspaceId,
        userId: targetUserId
    });
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
        livekitAgentName: String(process.env.WEBMEET_LIVEKIT_AGENT_NAME || 'webmeet-agent').trim() || 'webmeet-agent',
        egressUrl: String(process.env.WEBMEET_EGRESS_URL || '').trim(),
        recordingsDir: String(process.env.WEBMEET_RECORDINGS_DIR || '/data/recordings').trim() || '/data/recordings',
        turn: {
            host: String(process.env.WEBMEET_TURN_EXTERNAL_IP || process.env.WEBMEET_TURN_HOST || '').trim(),
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
    recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.MEETING_CREATED, { meetingId, roomType });

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
        encryption: {
            masterKey: MASTER_KEY_VAR
        },
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
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.MEETING_RENAMED, {
            meetingId,
            title: nextTitle
        });
    });
    meeting = buildMeetingView(loadMeetingRecord(context, meetingId));
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
    const meeting = {
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
    recordWorkspaceEvent(context, effectiveWorkspaceId, WEBMEET_EVENT_TYPES.MEETING_CREATED, {
        workspaceId: effectiveWorkspaceId,
        meetingId: meeting.id,
        meeting
    });
    return meeting;
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
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                guest: true,
                pendingLiveKit: true
            };
            members.push(participant);
        } else {
            participant.displayName = effectiveDisplayName;
            participant.lastSeenAt = joinedAt;
            participant.guest = true;
            participant.pendingLiveKit = true;
        }
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participantIdentity, guest: true });
    });
    const rtcConfig = buildRtcConfig(context);

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
        ...(rtcConfig ? { rtcConfig } : {}),
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
        String(entry?.id || '').trim() === targetParticipantId
        && (
            entry?.guest === true
            || !String(entry?.userId || '').trim()
        )
    )) || null;
    if (!participant) {
        throw new Error('Guest participant is not joined.');
    }
    return participant;
}

export async function getGuestMeetingDetails(context, { meetingId, guestToken, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    let participants;
    try {
        participants = await getRealtimeMeetingParticipants(context, record, payload, {
            preserveStoredMembersOnEmpty: true
        });
    } catch {
        participants = projectStoredMeetingParticipants(payload);
    }
    return {
        meeting: buildMeetingView(record),
        participants,
        chat: payload.chatMessages,
        transcript: payload.transcriptSegments,
        artifacts: payload.artifacts,
        recordings: payload.recordings,
        tasks: payload.tasks,
        decisions: payload.decisions,
        agents: payload.agents
    };
}

export function pingGuestMeetingPresence(context, { meetingId, guestToken, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return pingMeetingPresence(context, { meetingId, participantId });
}

export async function leaveGuestMeeting(context, { meetingId, guestToken, participantId }) {
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return leaveMeeting(context, { meetingId, participantId });
}

export function updateGuestMeetingParticipantAvatar(context, {
    meetingId,
    guestToken,
    participantId,
    avatar = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const record = loadMeetingRecord(context, targetMeetingId);
    assertGuestMeetingAccess(record, guestToken);
    let profileAvatar = null;
    mutateMeeting(context, targetMeetingId, (_record, payload) => {
        assertGuestParticipant(payload, targetParticipantId);
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${targetParticipantId}`);
        recordMeetingEvent(context, targetMeetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_UPDATED, {
            meetingId: targetMeetingId,
            participantId: targetParticipantId,
            userId: ''
        });
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

export function joinMeeting(context, { meetingId, displayName, participantId, avatar = null, authInfo = null }) {
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || getAuthDisplayName(authInfo) || 'Participant').trim() || 'Participant';
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    const participantAttributes = userId
        ? {
            webmeetUserId: userId,
            userId,
            workspaceUserId: userId,
            ploinkyUserId: userId
        }
        : {};
    const joinedAt = nowIso();
    let participant = null;
    const { record } = mutateMeeting(context, meetingId, (_record, payload) => {
        cleanupStaleMembers(context, meetingId, payload);
        participant = payload.members.find((entry) => entry.id === participantIdentity) || null;
        if (!participant) {
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                pendingLiveKit: true
            };
            payload.members.push(participant);
            recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participant.id });
        } else {
            participant.displayName = effectiveDisplayName;
            if (!participant.joinedAt) {
                participant.joinedAt = joinedAt;
            }
            participant.lastSeenAt = joinedAt;
            participant.pendingLiveKit = true;
        }
        if (userId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                ...participantAttributes
            };
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
        participantToken: createLiveKitToken(context, {
            roomName: record.roomName,
            identity: participant.id,
            name: effectiveDisplayName,
            attributes: participantAttributes,
            metadata: userId ? JSON.stringify({ webmeetUserId: userId }) : ''
        }),
        participantIdentity: participant.id,
        ...(rtcConfig ? { rtcConfig } : {})
    };
}

export function updateMeetingParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null,
    authInfo = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    if (!userId) {
        throw new Error('Authentication is required to publish a participant avatar.');
    }
    let participant = null;
    let profileAvatar = null;
    mutateMeeting(context, targetMeetingId, (_record, payload) => {
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        const participantUserId = String(participant.userId || participant.attributes?.webmeetUserId || '').trim();
        if (participantUserId && participantUserId !== userId && !isAdminAuthInfo(authInfo)) {
            throw new Error('Access denied: cannot publish another participant avatar.');
        }
        if (!participantUserId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                webmeetUserId: userId,
                userId,
                workspaceUserId: userId,
                ploinkyUserId: userId
            };
        }
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${userId}`);
        recordMeetingEvent(context, targetMeetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_AVATAR_UPDATED, {
            meetingId: targetMeetingId,
            participantId: targetParticipantId,
            userId
        });
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

export async function leaveMeeting(context, { meetingId, participantId }) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    let noHumanParticipantsRemain = false;
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
            recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId,
                participantId: targetParticipantId
            });
        }
        noHumanParticipantsRemain = nextMembers.length === 0;
    });
    const detachedAgents = noHumanParticipantsRemain
        ? await detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, 'no_human_participants')
        : [];
    return {
        ok: true,
        removed: Boolean(removedParticipant),
        participantId: targetParticipantId,
        detachedAgents
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

export async function appendMeetingChat(context, { meetingId, authorId, authorName, message, kind = 'user', metadata = null }) {
    cleanupMeetingPresence(context, meetingId);
    let chatMessage = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        chatMessage = {
            id: randomId('chat'),
            meetingId,
            authorId,
            authorName,
            message,
            kind: String(kind || 'user').trim() || 'user',
            createdAt: nowIso()
        };
        if (metadata && typeof metadata === 'object') {
            chatMessage.metadata = metadata;
        }
        payload.chatMessages.push(chatMessage);
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.CHAT_MESSAGE_CREATED, { meetingId, chatMessageId: chatMessage.id });
    });
    return { message: chatMessage };
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

export async function appendMeetingTranscript(context, { meetingId, speakerId, speakerName, text, startedAt = '', endedAt = '', source = 'manual' }) {
    cleanupMeetingPresence(context, meetingId);
    let segment = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        const createdAt = nowIso();
        segment = {
            id: randomId('transcript'),
            meetingId,
            speakerId,
            speakerName,
            text,
            startedAt: String(startedAt || createdAt),
            endedAt: String(endedAt || ''),
            source: String(source || 'manual'),
            createdAt
        };
        payload.transcriptSegments.push(segment);
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.TRANSCRIPT_UPDATED, { meetingId, segmentId: segment.id });
    });
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

function formatTranscriptMarkdown(record, payload) {
    const title = String(record?.title || 'WebMeet transcript').trim() || 'WebMeet transcript';
    const segments = Array.isArray(payload?.transcriptSegments) ? payload.transcriptSegments : [];
    const lines = [
        `# ${title}`,
        '',
        `Meeting: ${record?.meetingId || ''}`,
        `Generated: ${nowIso()}`,
        ''
    ];
    if (!segments.length) {
        lines.push('_No transcript segments recorded._', '');
        return lines.join('\n');
    }
    for (const segment of segments) {
        const speakerName = String(segment?.speakerName || segment?.speakerId || 'Speaker').trim() || 'Speaker';
        const timestamp = String(segment?.startedAt || segment?.createdAt || '').trim();
        const source = String(segment?.source || '').trim();
        lines.push(`## ${speakerName}${timestamp ? ` - ${timestamp}` : ''}${source ? ` (${source})` : ''}`);
        lines.push('');
        lines.push(String(segment?.text || '').trim());
        lines.push('');
    }
    return lines.join('\n');
}

export function formatMeetingTranscriptMarkdown(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    const payload = decryptMeetingPayload(context, record);
    return formatTranscriptMarkdown(record, payload);
}

export function formatGuestMeetingTranscriptMarkdown(context, { meetingId, guestToken, participantId }) {
    cleanupMeetingPresence(context, meetingId);
    const record = loadMeetingRecord(context, meetingId);
    assertGuestMeetingAccess(record, guestToken);
    const payload = decryptMeetingPayload(context, record);
    assertGuestParticipant(payload, participantId);
    return formatTranscriptMarkdown(record, payload);
}

export async function attachMeetingAgent(context, { meetingId, agentType, mode, authInfo = null }) {
    cleanupMeetingPresence(context, meetingId);
    assertAdminAuthInfo(authInfo);
    const record = loadMeetingRecord(context, meetingId);
    const currentPayload = decryptMeetingPayload(context, record);
    if (!hasHumanMeetingMembers(currentPayload)) {
        throw new Error('Cannot attach AI agents to an empty room.');
    }
    const currentAgent = currentPayload.agents.find((entry) => (
        entry.agentType === agentType && entry.mode === mode && !entry.deletedAt
    ));
    const metadata = {
        meetingId: record.meetingId,
        workspaceId: record.workspaceId,
        roomType: record.roomType || 'team',
        agentType,
        mode
    };
    if (currentAgent) {
        const currentDispatch = await getLiveKitAgentDispatch(context, record.roomName, currentAgent.dispatchId);
        const currentParticipant = currentDispatch && !isDeletedLiveKitDispatch(currentDispatch)
            ? await getLiveKitAgentParticipant(context, record.roomName, metadata)
            : null;
        if (currentParticipant) {
            return {
                ...currentAgent,
                dispatch: currentDispatch,
                participant: currentParticipant,
                status: 'dispatched'
            };
        }
    }
    const dispatch = await callLiveKitAgentDispatchApi(context, 'CreateDispatch', record.roomName, {
        agentName: context.livekitAgentName,
        room: record.roomName,
        metadata: JSON.stringify(metadata)
    });
    const dispatchId = getAgentDispatchId(dispatch);
    const confirmation = await waitForLiveKitAgentDispatch(context, record.roomName, dispatchId, metadata);
    let agent = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        const targetAgent = currentAgent
            ? payload.agents.find((entry) => entry.id === currentAgent.id)
            : null;
        agent = targetAgent || {
            id: randomId('agent'),
            meetingId,
            agentType,
            mode,
            createdAt: nowIso()
        };
        Object.assign(agent, {
            agentName: context.livekitAgentName,
            dispatchId,
            participantIdentity: confirmation.participant.identity || '',
            participantSid: confirmation.participant.sid || '',
            dispatch: confirmation.dispatch,
            participant: confirmation.participant,
            status: 'dispatched',
            updatedAt: nowIso()
        });
        if (!targetAgent) {
            payload.agents.push(agent);
        }
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
            meetingId,
            agentId: agent.id,
            agentType,
            mode,
            dispatchId: agent.dispatchId
        });
    });
    return agent;
}

export function listMeetingAgents(context, meetingId) {
    cleanupMeetingPresence(context, meetingId);
    return decryptMeetingPayload(context, loadMeetingRecord(context, meetingId)).agents;
}

export async function detachMeetingAgent(context, { meetingId, agentId, authInfo = null }) {
    cleanupMeetingPresence(context, meetingId);
    assertAdminAuthInfo(authInfo);
    const targetAgentId = String(agentId || '').trim();
    if (!targetAgentId) {
        throw new Error('Missing agentId.');
    }
    const record = loadMeetingRecord(context, meetingId);
    const currentPayload = decryptMeetingPayload(context, record);
    const currentAgent = currentPayload.agents.find((entry) => (
        String(entry?.id || '') === targetAgentId && !entry.deletedAt
    ));
    if (!currentAgent) {
        throw new Error('Meeting agent not found.');
    }
    if (currentAgent.dispatchId) {
        try {
            await callLiveKitAgentDispatchApi(context, 'DeleteDispatch', record.roomName, {
                room: record.roomName,
                dispatchId: currentAgent.dispatchId
            });
        } catch {
            // Persist the detach even if LiveKit already removed the dispatch.
        }
    }
    let detachedAgent = null;
    mutateMeeting(context, meetingId, (_record, payload) => {
        const targetAgent = payload.agents.find((entry) => String(entry?.id || '') === targetAgentId);
        if (!targetAgent) return;
        Object.assign(targetAgent, {
            status: 'detached',
            deletedAt: nowIso(),
            updatedAt: nowIso()
        });
        detachedAgent = { ...targetAgent };
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.AGENT_DETACHED, {
            meetingId,
            agentId: targetAgentId,
            agentType: targetAgent.agentType || '',
            mode: targetAgent.mode || ''
        });
    });
    return detachedAgent || { id: targetAgentId, status: 'detached' };
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
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.RECORDING_STARTED, { meetingId, recordingId: recording.id, egressId: recording.egressId, filePath: recording.filePath });
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
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.RECORDING_STOPPED, { meetingId, recordingId: recording.id, egressId: recording.egressId, filePath: recording.filePath });
        recordMeetingEvent(context, meetingId, payload, WEBMEET_EVENT_TYPES.ARTIFACT_CREATED, { meetingId, artifactId: artifact.id });
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
