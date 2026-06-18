import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const LOCK_DEFAULT_TIMEOUT_MS = 5_000;
const LOCK_DEFAULT_STALE_TTL_MS = 60_000;
const LOCK_RETRY_BASE_MS = 20;
const LOCK_RETRY_MAX_MS = 200;

const roomMutationQueues = new Map();

function getLockTimeoutMs() {
    const env = parseInt(process.env.WEBMEET_LOCK_TIMEOUT_MS || '', 10);
    return Number.isFinite(env) && env >= 100 ? env : LOCK_DEFAULT_TIMEOUT_MS;
}

function getLockStaleTtlMs() {
    const env = parseInt(process.env.WEBMEET_LOCK_STALE_TTL_MS || '', 10);
    return Number.isFinite(env) && env >= 1_000 ? env : LOCK_DEFAULT_STALE_TTL_MS;
}

function isLockOwnerProcessAlive(owner) {
    if (String(owner?.hostname || '') !== os.hostname()) {
        return false;
    }
    const pid = Number(owner?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
        return false;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
}

async function readRoomLockInfo(lockPath) {
    let stat;
    try {
        stat = await fs.stat(lockPath);
    } catch (error) {
        if (error?.code === 'ENOENT') {
            return { exists: false };
        }
        throw error;
    }
    const ownerPath = stat.isDirectory() ? path.join(lockPath, 'owner.json') : lockPath;
    try {
        const raw = await fs.readFile(ownerPath, 'utf8');
        const owner = JSON.parse(raw);
        const ownerStartedAt = Date.parse(owner?.startedAt || '');
        return {
            exists: true,
            stat,
            owner,
            ageMs: Number.isFinite(ownerStartedAt) ? Date.now() - ownerStartedAt : Date.now() - stat.mtimeMs,
            readableOwner: true
        };
    } catch {
        return {
            exists: true,
            stat,
            owner: null,
            ageMs: Date.now() - stat.mtimeMs,
            readableOwner: false
        };
    }
}

function isSameLockInfo(left, right) {
    if (!left?.exists || !right?.exists) {
        return false;
    }
    return left.stat.dev === right.stat.dev
        && left.stat.ino === right.stat.ino
        && left.stat.mtimeMs === right.stat.mtimeMs
        && left.stat.size === right.stat.size
        && String(left.owner?.token || '') === String(right.owner?.token || '');
}

async function removeStaleRoomLock(lockPath, observedInfo) {
    const latestInfo = await readRoomLockInfo(lockPath);
    if (!isSameLockInfo(observedInfo, latestInfo)) {
        return false;
    }
    await fs.rm(lockPath, { recursive: true, force: true });
    return true;
}

function isStaleRoomLock(info, staleTtlMs) {
    if (!info?.exists || info.ageMs <= staleTtlMs) {
        return false;
    }
    if (info.readableOwner && isLockOwnerProcessAlive(info.owner)) {
        return false;
    }
    return true;
}

function formatLockOwner(lockInfo) {
    if (!lockInfo?.exists) {
        return 'no current owner';
    }
    const ageSeconds = Math.max(0, Math.round(Number(lockInfo.ageMs || 0) / 1000));
    if (!lockInfo.readableOwner || !lockInfo.owner) {
        return `unreadable owner, age ${ageSeconds}s`;
    }
    const pid = Number.isInteger(Number(lockInfo.owner.pid)) ? String(lockInfo.owner.pid) : 'unknown';
    const hostname = String(lockInfo.owner.hostname || 'unknown').trim() || 'unknown';
    const startedAt = String(lockInfo.owner.startedAt || '').trim();
    return `owner pid ${pid} on ${hostname}, age ${ageSeconds}s${startedAt ? `, startedAt ${startedAt}` : ''}`;
}

async function acquireRoomLock(context, roomId, options = {}) {
    const lockPath = path.join(context.meetingLocksDir, `${roomId}.lock`);
    const token = crypto.randomUUID();
    const timeoutMs = options.timeoutMs ?? getLockTimeoutMs();
    const staleTtlMs = options.staleTtlMs ?? getLockStaleTtlMs();
    const deadline = Date.now() + timeoutMs;

    await fs.mkdir(context.meetingLocksDir, { recursive: true });

    while (true) {
        const owner = {
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            roomId,
            meetingId: roomId,
            token,
        };
        try {
            const handle = await fs.open(lockPath, 'wx');
            try {
                await handle.writeFile(JSON.stringify(owner));
            } finally {
                await handle.close();
            }
            return { lockPath, token, roomId };
        } catch (error) {
            if (error?.code !== 'EEXIST') throw error;

            const lockInfo = await readRoomLockInfo(lockPath);
            if (!lockInfo.exists) {
                continue;
            }
            if (isStaleRoomLock(lockInfo, staleTtlMs)) {
                try {
                    if (await removeStaleRoomLock(lockPath, lockInfo)) {
                        continue;
                    }
                } catch {
                    // Another process may have cleaned it up already.
                }
            }

            if (Date.now() >= deadline) {
                throw new Error(`Timed out acquiring meeting lock for ${roomId} after ${timeoutMs}ms (${formatLockOwner(lockInfo)}).`);
            }

            const jitter = LOCK_RETRY_BASE_MS + Math.random() * (LOCK_RETRY_MAX_MS - LOCK_RETRY_BASE_MS);
            await new Promise((resolve) => setTimeout(resolve, jitter));
        }
    }
}

async function releaseRoomLock(handle) {
    if (!handle?.lockPath || !handle?.token) return;
    try {
        const raw = await fs.readFile(handle.lockPath, 'utf8');
        const owner = JSON.parse(raw);
        if (owner.token !== handle.token) return;
        await fs.rm(handle.lockPath, { force: true });
    } catch {
        // Lock file already removed or unreadable; the timeout path can recover it.
    }
}

async function withRoomLock(context, roomId, fn, options = {}) {
    const handle = await acquireRoomLock(context, roomId, options);
    try {
        return await fn();
    } finally {
        await releaseRoomLock(handle);
    }
}

export async function withQueuedRoomLock(context, roomId, fn, options = {}) {
    const key = String(roomId || '').trim();
    if (!key) {
        throw new Error('Meeting not found.');
    }
    const previous = roomMutationQueues.get(key) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => withRoomLock(context, key, fn, options));
    roomMutationQueues.set(key, run);
    try {
        return await run;
    } finally {
        if (roomMutationQueues.get(key) === run) {
            roomMutationQueues.delete(key);
        }
    }
}
