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

function ensureEventDirs(paths) {
    fs.mkdirSync(paths.eventsDir, { recursive: true });
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function createQueueContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    ensureEventDirs(paths);
    return paths;
}

export function appendEventLog(startDir, meetingId, event) {
    const paths = createQueueContext(startDir);
    const eventId = String(event?.id || randomId('event')).trim();
    const filePath = path.join(paths.eventsDir, meetingId, `${event.createdAt || nowIso()}-${eventId}.json`.replaceAll(':', '-'));
    writeJson(filePath, event);
}
