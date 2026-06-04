import fs from 'node:fs/promises';
import path from 'node:path';

import { getWorkspacePaths } from './workspacePaths.mjs';
import { getWebMeetEventCreatedAt, getWebMeetEventId } from '../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

async function ensureEventDirs(paths) {
    await fs.mkdir(paths.eventsDir, { recursive: true });
}

async function writeEvent(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${String(value || '').trim()}\n`);
}

export async function createQueueContext(startDir = '') {
    const paths = getWorkspacePaths(startDir);
    await ensureEventDirs(paths);
    return paths;
}

export async function appendEventLog(startDir, meetingId, event) {
    const paths = await createQueueContext(startDir);
    const encodedEvent = String(event || '').trim();
    const eventId = getWebMeetEventId(encodedEvent);
    const createdAt = getWebMeetEventCreatedAt(encodedEvent) || nowIso();
    const filePath = path.join(paths.eventsDir, meetingId, `${createdAt}-${eventId}.event`.replaceAll(':', '-'));
    await writeEvent(filePath, encodedEvent);
}

export async function appendWorkspaceEventLog(startDir, workspaceId, event) {
    const paths = await createQueueContext(startDir);
    const encodedEvent = String(event || '').trim();
    const eventId = getWebMeetEventId(encodedEvent);
    const safeWorkspaceId = String(workspaceId || '').trim();
    if (!safeWorkspaceId) return;
    const createdAt = getWebMeetEventCreatedAt(encodedEvent) || nowIso();
    const filePath = path.join(paths.eventsDir, 'workspaces', safeWorkspaceId, `${createdAt}-${eventId}.event`.replaceAll(':', '-'));
    await writeEvent(filePath, encodedEvent);
}
