import fs from 'node:fs';
import path from 'node:path';

import { getWorkspacePaths } from './workspacePaths.mjs';
import { getWebMeetEventCreatedAt, getWebMeetEventId } from '../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

function ensureEventDirs(paths) {
    fs.mkdirSync(paths.eventsDir, { recursive: true });
}

function writeEvent(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${String(value || '').trim()}\n`);
}

export function createQueueContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    ensureEventDirs(paths);
    return paths;
}

export function appendEventLog(startDir, meetingId, event) {
    const paths = createQueueContext(startDir);
    const encodedEvent = String(event || '').trim();
    const eventId = getWebMeetEventId(encodedEvent);
    const createdAt = getWebMeetEventCreatedAt(encodedEvent) || nowIso();
    const filePath = path.join(paths.eventsDir, meetingId, `${createdAt}-${eventId}.event`.replaceAll(':', '-'));
    writeEvent(filePath, encodedEvent);
}

export function appendWorkspaceEventLog(startDir, workspaceId, event) {
    const paths = createQueueContext(startDir);
    const encodedEvent = String(event || '').trim();
    const eventId = getWebMeetEventId(encodedEvent);
    const safeWorkspaceId = String(workspaceId || '').trim();
    if (!safeWorkspaceId) return;
    const createdAt = getWebMeetEventCreatedAt(encodedEvent) || nowIso();
    const filePath = path.join(paths.eventsDir, 'workspaces', safeWorkspaceId, `${createdAt}-${eventId}.event`.replaceAll(':', '-'));
    writeEvent(filePath, encodedEvent);
}
