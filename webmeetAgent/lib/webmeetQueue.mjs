import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { getWorkspacePaths } from './workspacePaths.mjs';

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function ensureQueueDirs(paths) {
    fs.mkdirSync(paths.eventsDir, { recursive: true });
    fs.mkdirSync(paths.jobsPendingDir, { recursive: true });
    fs.mkdirSync(paths.jobsProcessingDir, { recursive: true });
    fs.mkdirSync(paths.jobsDoneDir, { recursive: true });
    fs.mkdirSync(paths.jobsFailedDir, { recursive: true });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function createQueueContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    ensureQueueDirs(paths);
    return paths;
}

export function appendEventLog(startDir, meetingId, event) {
    const paths = createQueueContext(startDir);
    const eventId = String(event?.id || randomId('event')).trim();
    const filePath = path.join(paths.eventsDir, meetingId, `${event.createdAt || nowIso()}-${eventId}.json`.replaceAll(':', '-'));
    writeJson(filePath, event);
}

export function enqueueJob(startDir, type, payload = {}) {
    const paths = createQueueContext(startDir);
    const id = randomId('job');
    const job = {
        id,
        type,
        payload,
        status: 'pending',
        createdAt: nowIso(),
        updatedAt: nowIso()
    };
    writeJson(path.join(paths.jobsPendingDir, `${id}.json`), job);
    return job;
}

export function claimNextJob(startDir, acceptedTypes = []) {
    const paths = createQueueContext(startDir);
    const allowed = new Set(acceptedTypes);
    const files = fs.readdirSync(paths.jobsPendingDir).filter((name) => name.endsWith('.json')).sort();
    for (const name of files) {
        const pendingPath = path.join(paths.jobsPendingDir, name);
        let job = null;
        try {
            job = readJson(pendingPath);
        } catch (_) {
            continue;
        }
        if (allowed.size && !allowed.has(job.type)) {
            continue;
        }
        const processingPath = path.join(paths.jobsProcessingDir, name);
        try {
            fs.renameSync(pendingPath, processingPath);
            job.status = 'processing';
            job.updatedAt = nowIso();
            writeJson(processingPath, job);
            return { job, filePath: processingPath };
        } catch (_) {
            continue;
        }
    }
    return null;
}

export function completeJob(filePath, result = {}) {
    const job = readJson(filePath);
    job.status = 'done';
    job.result = result;
    job.updatedAt = nowIso();
    const target = path.join(path.dirname(path.dirname(filePath)), 'done', path.basename(filePath));
    writeJson(target, job);
    fs.rmSync(filePath, { force: true });
    return job;
}

export function failJob(filePath, error) {
    const job = readJson(filePath);
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : String(error);
    job.updatedAt = nowIso();
    const target = path.join(path.dirname(path.dirname(filePath)), 'failed', path.basename(filePath));
    writeJson(target, job);
    fs.rmSync(filePath, { force: true });
    return job;
}

export async function waitForJob(startDir, jobId, timeoutMs = 15000, pollMs = 250) {
    const paths = createQueueContext(startDir);
    const donePath = path.join(paths.jobsDoneDir, `${jobId}.json`);
    const failedPath = path.join(paths.jobsFailedDir, `${jobId}.json`);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(donePath)) {
            return readJson(donePath);
        }
        if (fs.existsSync(failedPath)) {
            const failed = readJson(failedPath);
            throw new Error(failed.error || 'Worker job failed.');
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    throw new Error(`Timed out waiting for worker job ${jobId}.`);
}
