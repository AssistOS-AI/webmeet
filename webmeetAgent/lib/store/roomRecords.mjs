import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

import { resolveVarValue } from '../secretVars.mjs';
import { createWrappedDek, decryptPayload, deriveMasterKey, encryptPayload, unwrapDek } from '../webmeetCrypto.mjs';
import { withQueuedRoomLock } from './roomLocks.mjs';
import {
    recordRoomEvent as appendRoomEvent,
    recordWorkspaceEvent as appendWorkspaceEvent
} from './eventLogs.mjs';
import {
    WEBMEET_EVENT_TYPES,
    parseWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

const MASTER_KEY_VAR = 'PLOINKY_WEBMEET_MASTER_KEY';
const RETENTION_DAYS_VAR = 'PLOINKY_WEBMEET_RETENTION_DAYS';
const PRESENCE_TTL_MS_VAR = 'PLOINKY_WEBMEET_PRESENCE_TTL_MS';
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_PRESENCE_TTL_MS = 30_000;
const ROOM_SCHEMA_VERSION = 2;
const ROOMS_WORKSPACE_ID = 'rooms';
const PERMANENT_ROOM_ID_PATTERN = /^room_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
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

export function getPresenceTtlMs(workspaceRoot) {
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

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

async function readJsonFile(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJsonFile(filePath, record) {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`);
    await fs.rename(tempPath, filePath);
}

async function listJsonFiles(dir) {
    let names;
    try {
        names = await fs.readdir(dir);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    return names
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(dir, name));
}

export async function ensureStoreDirs(paths) {
    await Promise.all([
        fs.mkdir(paths.meetingsDir, { recursive: true }),
        fs.mkdir(paths.resourcesDir, { recursive: true }),
        fs.mkdir(paths.eventsDir, { recursive: true }),
        fs.mkdir(paths.deletionsDir, { recursive: true }),
        fs.mkdir(paths.meetingLocksDir, { recursive: true }),
        fs.mkdir(paths.jobsPendingDir, { recursive: true }),
        fs.mkdir(paths.jobsProcessingDir, { recursive: true }),
        fs.mkdir(paths.jobsDoneDir, { recursive: true }),
        fs.mkdir(paths.jobsFailedDir, { recursive: true })
    ]);
}

export async function purgeExpiredRooms(paths) {
    const now = Date.now();
    for (const filePath of await listJsonFiles(paths.meetingsDir)) {
        try {
            const record = await readJsonFile(filePath);
            if (record?.expiresAt && now > Date.parse(record.expiresAt)) {
                const roomId = String(record?.meetingId || path.basename(filePath, '.json')).trim();
                if (roomId) {
                    await withQueuedRoomLock(paths, roomId, async () => {
                        let latestRecord = null;
                        try {
                            latestRecord = await readJsonFile(filePath);
                        } catch (error) {
                            if (error?.code !== 'ENOENT') throw error;
                        }
                        if (latestRecord?.expiresAt && now > Date.parse(latestRecord.expiresAt)) {
                            await fs.rm(path.join(paths.eventsDir, roomId), { recursive: true, force: true });
                            await fs.rm(filePath, { force: true });
                        }
                    });
                }
            }
        } catch (_) {
            // Ignore malformed or concurrently removed records during startup cleanup.
        }
    }
}

function createRoomPayload() {
    return {
        members: [],
        agents: [],
        chatMessages: [],
        resources: []
    };
}

export async function loadRoomRecord(context, roomId) {
    const filePath = filePathFor(context.meetingsDir, roomId);
    if (!(await pathExists(filePath))) {
        throw new Error('Meeting not found.');
    }
    try {
        return await readJsonFile(filePath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            throw new Error('Meeting not found.');
        }
        throw error;
    }
}

function buildEncryptionAad(context, recordOrRoomId, recordType) {
    const roomId = typeof recordOrRoomId === 'string'
        ? recordOrRoomId
        : String(recordOrRoomId?.roomId || recordOrRoomId?.meetingId || '').trim();
    return {
        agentId: String(context.agentName || 'WebMeetAgent').trim() || 'WebMeetAgent',
        roomId,
        recordType,
        schemaVersion: ROOM_SCHEMA_VERSION
    };
}

function hasAadEncryptedPayload(record) {
    return Boolean(record?.encryption?.aad);
}

function openRoomPayload(context, record) {
    const masterKey = ensureMasterKey(context.workspaceRoot);
    let dek;
    let payload;
    if (hasAadEncryptedPayload(record)) {
        dek = unwrapDek(masterKey, record.dek, buildEncryptionAad(context, record, 'room_dek'));
        payload = decryptPayload(dek, record.payload, buildEncryptionAad(context, record, 'room_payload'));
        return { dek, payload };
    }
    dek = unwrapDek(masterKey, record.dek);
    payload = decryptPayload(dek, record.payload);
    return { dek, payload };
}

export function decryptRoomPayload(context, record) {
    return openRoomPayload(context, record).payload;
}

async function saveRoomRecord(context, record, payload) {
    const opened = openRoomPayload(context, record);
    record.payload = encryptPayload(opened.dek, payload, buildEncryptionAad(context, record, 'room_payload'));
    record.encryption = {
        ...(record.encryption && typeof record.encryption === 'object' ? record.encryption : {}),
        masterKey: MASTER_KEY_VAR,
        aad: buildEncryptionAad(context, record, 'room_payload')
    };
    record.updatedAt = nowIso();
    await writeJsonFile(filePathFor(context.meetingsDir, record.meetingId), record);
}

export async function mutateRoom(context, roomId, mutator) {
    const key = String(roomId || '').trim();
    return withQueuedRoomLock(context, key, async () => {
        const record = await loadRoomRecord(context, roomId);
        const payload = decryptRoomPayload(context, record);
        const stagedEvents = [];
        const stageEvent = (scope, type, data = {}) => {
            stagedEvents.push({ scope, meetingId: key, type, data });
        };
        const result = await mutator(record, payload, stageEvent) || {};
        await saveRoomRecord(context, record, payload);
        for (const intent of stagedEvents) {
            try {
                if (intent.scope === 'workspace') {
                    await recordWorkspaceEvent(context, intent.data.workspaceId || record.workspaceId, intent.type, intent.data);
                } else {
                    await recordRoomEvent(context, intent.meetingId, intent.type, intent.data);
                }
            } catch {
                // Event append is best-effort after successful payload save.
            }
        }
        return { record, payload, result };
    });
}

export async function recordRoomEvent(context, roomId, type, data = {}) {
    return await appendRoomEvent({
        ...context,
        loadRoomRecord: (targetRoomId) => loadRoomRecord(context, targetRoomId)
    }, roomId, type, data);
}

export async function recordWorkspaceEvent(context, workspaceId, type, data = {}) {
    return await appendWorkspaceEvent(context, workspaceId, type, data);
}

function buildRoomName(prefix, workspaceId, roomId) {
    return `${prefix}-${workspaceId}-${roomId}`
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .slice(0, 160);
}

export function buildRoomView(record) {
    return {
        id: record?.roomId || record?.meetingId,
        roomId: record?.roomId || record?.meetingId,
        name: record?.name || record?.title,
        title: record?.name || record?.title,
        roomType: record?.roomType || 'team',
        roomName: record?.roomName,
        status: record?.status,
        createdAt: record?.createdAt,
        updatedAt: record?.updatedAt,
        archivedAt: record?.archivedAt || null
    };
}

export async function createRoomRecord(context, title, roomType = 'team') {
    const roomId = randomId('room');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + getRetentionDays(context.workspaceRoot) * 24 * 60 * 60 * 1000).toISOString();
    const masterKey = ensureMasterKey(context.workspaceRoot);
    const { wrapped, dek } = createWrappedDek(masterKey, buildEncryptionAad(context, roomId, 'room_dek'));
    const payload = createRoomPayload();

    const isGuestRoom = roomType === 'guest';

    const record = {
        version: ROOM_SCHEMA_VERSION,
        roomId,
        meetingId: roomId,
        name: title,
        title,
        roomType: isGuestRoom ? 'guest' : 'team',
        workspaceId: ROOMS_WORKSPACE_ID,
        roomName: buildRoomName(context.roomPrefix, ROOMS_WORKSPACE_ID, roomId),
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        expiresAt,
        dek: wrapped,
        encryption: {
            masterKey: MASTER_KEY_VAR,
            aad: buildEncryptionAad(context, roomId, 'room_payload')
        },
        payload: encryptPayload(dek, payload, buildEncryptionAad(context, roomId, 'room_payload'))
    };
    await writeJsonFile(filePathFor(context.meetingsDir, roomId), record);
    try {
        await recordRoomEvent(context, roomId, WEBMEET_EVENT_TYPES.MEETING_CREATED, {
            workspaceId: ROOMS_WORKSPACE_ID,
            meetingId: roomId,
            roomId,
            roomType: record.roomType,
            meeting: buildRoomView(record)
        });
    } catch {
        // Event append is best-effort after the room record is durable.
    }
    return record;
}

export async function removeRoomRecord(context, roomId) {
    const key = String(roomId || '').trim();
    if (!key) return;
    await withQueuedRoomLock(context, key, async () => {
        await fs.rm(path.join(context.eventsDir, key), { recursive: true, force: true });
        await fs.rm(filePathFor(context.meetingsDir, key), { force: true });
    });
}

function assertPermanentRoomId(roomId) {
    const targetRoomId = String(roomId || '').trim();
    if (!PERMANENT_ROOM_ID_PATTERN.test(targetRoomId)) {
        throw new Error('Room not found.');
    }
    return targetRoomId;
}

function resolveRoomWorkspaceDirectory(context, record, payload) {
    const folderPath = String(payload?.scripta?.folderPath || '').trim();
    if (!folderPath) return '';

    const roomId = String(record?.meetingId || record?.roomId || '').trim();
    const shortRoomId = roomId.replace(/^room_/, '').slice(0, 8);
    const segments = folderPath.split('/');
    if (
        folderPath.includes('\\')
        || path.posix.normalize(folderPath) !== folderPath
        || segments.length !== 3
        || segments[0] !== ''
        || segments[1] !== 'WebMeet'
        || !segments[2]
        || !segments[2].endsWith(`-${shortRoomId}`)
    ) {
        throw new Error('Room workspace directory identity is invalid.');
    }

    const workspaceRoot = String(context?.workspaceRoot || '').trim();
    if (!workspaceRoot) {
        throw new Error('Room workspace directory is unavailable.');
    }
    const workspaceDirectory = path.resolve(workspaceRoot);
    const webMeetRoot = path.resolve(workspaceDirectory, 'WebMeet');
    const roomDirectory = path.resolve(webMeetRoot, segments[2]);
    if (
        workspaceDirectory === webMeetRoot
        || !webMeetRoot.startsWith(`${workspaceDirectory}${path.sep}`)
        || path.dirname(roomDirectory) !== webMeetRoot
    ) {
        throw new Error('Room workspace directory identity is invalid.');
    }
    return { roomDirectory, webMeetRoot, workspaceDirectory };
}

async function stageEmptyRoomWorkspaceDirectory(context, record, payload, transactionId) {
    const resolved = resolveRoomWorkspaceDirectory(context, record, payload);
    if (!resolved) return null;
    const {
        roomDirectory: sourcePath,
        webMeetRoot,
        workspaceDirectory
    } = resolved;

    let stat;
    try {
        stat = await fs.lstat(sourcePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Room workspace directory identity is invalid.');
    }
    const [realWorkspaceDirectory, realWebMeetRoot] = await Promise.all([
        fs.realpath(workspaceDirectory),
        fs.realpath(webMeetRoot)
    ]);
    if (realWebMeetRoot !== path.join(realWorkspaceDirectory, 'WebMeet')) {
        throw new Error('Room workspace directory identity is invalid.');
    }
    if ((await fs.readdir(sourcePath)).length > 0) {
        throw new Error('Room workspace directory is not empty; Explorer-owned content was preserved.');
    }

    const stagePath = path.join(
        path.dirname(sourcePath),
        `.${path.basename(sourcePath)}.webmeet-delete-${transactionId}`
    );
    try {
        await fs.rename(sourcePath, stagePath);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    return { sourcePath, stagePath };
}

async function rollbackRoomWorkspaceDirectory(stagedDirectory) {
    if (!stagedDirectory) return [];
    try {
        await fs.rename(stagedDirectory.stagePath, stagedDirectory.sourcePath);
        return [];
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        return [error];
    }
}

async function listWorkspaceEventFiles(context, roomId) {
    const workspaceEventsRoot = path.join(context.eventsDir, 'workspaces');
    let workspaceIds = [];
    try {
        workspaceIds = await fs.readdir(workspaceEventsRoot, { withFileTypes: true });
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
    const matches = [];
    for (const workspaceEntry of workspaceIds) {
        if (!workspaceEntry.isDirectory()) continue;
        const workspaceDir = path.join(workspaceEventsRoot, workspaceEntry.name);
        let eventNames = [];
        try {
            eventNames = await fs.readdir(workspaceDir);
        } catch (error) {
            if (error?.code === 'ENOENT') continue;
            throw error;
        }
        for (const eventName of eventNames) {
            if (!eventName.endsWith('.event')) continue;
            const eventPath = path.join(workspaceDir, eventName);
            let encodedEvent;
            try {
                encodedEvent = (await fs.readFile(eventPath, 'utf8')).trim();
            } catch (error) {
                if (error?.code === 'ENOENT') continue;
                throw error;
            }
            try {
                const parsed = parseWebMeetEvent(encodedEvent);
                if (
                    String(parsed?.payload?.meetingId || '').trim() === roomId
                    || String(parsed?.payload?.roomId || '').trim() === roomId
                ) {
                    matches.push(eventPath);
                }
            } catch {
                // A malformed or concurrently removed event is not attributed to this room.
            }
        }
    }
    return matches;
}

async function moveToDeletionStage(sourcePath, stagePath, moved, { required = false } = {}) {
    try {
        await fs.access(sourcePath);
    } catch (error) {
        if (error?.code === 'ENOENT' && !required) return;
        throw error;
    }
    await fs.mkdir(path.dirname(stagePath), { recursive: true });
    try {
        await fs.rename(sourcePath, stagePath);
        moved.push({ sourcePath, stagePath });
    } catch (error) {
        if (error?.code !== 'ENOENT' || required) throw error;
    }
}

async function rollbackDeletionStage(moved) {
    const rollbackErrors = [];
    for (const entry of [...moved].reverse()) {
        try {
            await fs.mkdir(path.dirname(entry.sourcePath), { recursive: true });
            await fs.rename(entry.stagePath, entry.sourcePath);
        } catch (error) {
            if (error?.code !== 'ENOENT') {
                rollbackErrors.push(error);
            }
        }
    }
    return rollbackErrors;
}

export async function deleteRoomRecord(context, roomId, beforeDelete = null) {
    const key = assertPermanentRoomId(roomId);
    return await withQueuedRoomLock(context, key, async () => {
        const record = await loadRoomRecord(context, key);
        const payload = decryptRoomPayload(context, record);
        if (typeof beforeDelete === 'function') {
            await beforeDelete(record, payload);
        }

        const workspaceEventFiles = await listWorkspaceEventFiles(context, key);
        const transactionId = crypto.randomUUID();
        const stagingDir = path.join(context.deletionsDir, `${key}-${transactionId}`);
        const moved = [];
        let stagedWorkspaceDirectory = null;
        await fs.mkdir(stagingDir, { recursive: true });
        try {
            await moveToDeletionStage(
                filePathFor(context.meetingsDir, key),
                path.join(stagingDir, 'room.json'),
                moved,
                { required: true }
            );
            await moveToDeletionStage(
                path.join(context.resourcesDir, key),
                path.join(stagingDir, 'resources'),
                moved
            );
            await moveToDeletionStage(
                path.join(context.eventsDir, key),
                path.join(stagingDir, 'room-events'),
                moved
            );
            for (const [index, eventPath] of workspaceEventFiles.entries()) {
                await moveToDeletionStage(
                    eventPath,
                    path.join(stagingDir, 'workspace-events', `${index}-${path.basename(eventPath)}`),
                    moved
                );
            }
            stagedWorkspaceDirectory = await stageEmptyRoomWorkspaceDirectory(
                context,
                record,
                payload,
                transactionId
            );
            if (stagedWorkspaceDirectory) {
                await fs.rmdir(stagedWorkspaceDirectory.stagePath);
            }
        } catch (error) {
            const rollbackErrors = [
                ...await rollbackRoomWorkspaceDirectory(stagedWorkspaceDirectory),
                ...await rollbackDeletionStage(moved)
            ];
            await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            if (rollbackErrors.length) {
                throw new AggregateError(
                    [error, ...rollbackErrors],
                    `Permanent deletion of room ${key} failed and could not be rolled back.`
                );
            }
            throw error;
        }

        await fs.rm(stagingDir, { recursive: true, force: true });
        return { record, payload };
    });
}

export async function listRoomRecords(context) {
    return await Promise.all((await listJsonFiles(context.meetingsDir)).map(async (filePath) => {
        try {
            return await readJsonFile(filePath);
        } catch (error) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }));
}
