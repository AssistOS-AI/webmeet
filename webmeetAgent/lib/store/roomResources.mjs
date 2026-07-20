import path from 'node:path';
import crypto from 'node:crypto';

import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    return `${prefix}_${crypto.randomUUID()}`;
}

function assertResourceStoragePath(context, roomId, resourceId, storagePath) {
    const target = path.resolve(String(storagePath || '').trim());
    const root = path.resolve(context.resourcesDir, String(roomId || '').trim(), 'uploads', String(resourceId || '').trim());
    if (!target || target !== root && !target.startsWith(root + path.sep)) {
        throw new Error('Invalid resource storage path.');
    }
    return target;
}

function buildResourceStoragePath(context, roomId, resourceId, filename) {
    const cleanName = path.basename(String(filename || 'upload.bin').replace(/\0/g, '')) || 'upload.bin';
    return path.join(context.resourcesDir, String(roomId || '').trim(), 'uploads', String(resourceId || '').trim(), cleanName);
}

function publicResourceView(resource = {}) {
    const { storagePath: _storagePath, path: _privatePath, documentId: _documentId, ...publicResource } = resource || {};
    return publicResource;
}

export async function authorizeResourceUpload(context, { roomId, filename, mimeType = '', size = 0, authInfo = null }, deps) {
    const record = await deps.loadMeetingRecord(context, roomId);
    if (!deps.canViewMeetingRecord(record, authInfo)) {
        throw new Error('Room not found.');
    }
    const resourceId = randomId('resource');
    const cleanName = path.basename(String(filename || 'upload.bin').replace(/\0/g, '')) || 'upload.bin';
    const storagePath = buildResourceStoragePath(context, roomId, resourceId, cleanName);
    return {
        ok: true,
        roomId,
        resourceId,
        filename: cleanName,
        mimeType: String(mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
        size: Number.isFinite(Number(size)) ? Number(size) : 0,
        storagePath
    };
}

export async function commitResourceUpload(context, {
    roomId,
    resourceId,
    filename,
    mimeType = '',
    size = 0,
    storagePath,
    ownerUserId = '',
    ownerParticipantId = '',
    visibility = 'room',
    authInfo = null
}, deps) {
    const targetPath = assertResourceStoragePath(context, roomId, resourceId, storagePath);
    let resource = null;
    await deps.mutateMeeting(context, roomId, (record, payload, stageEvent) => {
        if (!deps.canViewMeetingRecord(record, authInfo)) {
            throw new Error('Room not found.');
        }
        const resources = Array.isArray(payload.resources) ? payload.resources : [];
        payload.resources = resources;
        const cleanResourceId = String(resourceId || randomId('resource')).trim();
        const cleanName = path.basename(String(filename || 'upload.bin').replace(/\0/g, '')) || 'upload.bin';
        resource = {
            resourceId: cleanResourceId,
            roomId,
            ownerUserId: String(ownerUserId || '').trim(),
            ownerParticipantId: String(ownerParticipantId || '').trim(),
            filename: cleanName,
            mimeType: String(mimeType || 'application/octet-stream').trim() || 'application/octet-stream',
            size: Number.isFinite(Number(size)) ? Number(size) : 0,
            storagePath: targetPath,
            createdAt: nowIso(),
            deletedAt: null,
            visibility: String(visibility || 'room').trim() || 'room'
        };
        resources.push(resource);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.RESOURCE_CREATED, {
            meetingId: record.meetingId,
            roomId,
            resourceId: resource.resourceId
        });
    });
    return { ok: true, resource: publicResourceView(resource) };
}

export async function authorizeResourceDownload(context, { roomId, resourceId, authInfo = null }, deps) {
    const record = await deps.loadMeetingRecord(context, roomId);
    if (!deps.canViewMeetingRecord(record, authInfo)) {
        throw new Error('Room not found.');
    }
    const payload = deps.decryptMeetingPayload(context, record);
    const resource = (Array.isArray(payload.resources) ? payload.resources : [])
        .find((entry) => String(entry?.resourceId || '') === String(resourceId || '') && !entry?.deletedAt);
    if (!resource) {
        throw new Error('Resource not found.');
    }
    assertResourceStoragePath(context, roomId, resource.resourceId, resource.storagePath);
    return { ok: true, resource: publicResourceView(resource), storagePath: resource.storagePath };
}

export async function listRoomResources(context, roomId, authInfo = null, deps) {
    const record = await deps.loadMeetingRecord(context, roomId);
    if (!deps.canViewMeetingRecord(record, authInfo)) {
        throw new Error('Room not found.');
    }
    const payload = deps.decryptMeetingPayload(context, record);
    const resources = (Array.isArray(payload.resources) ? payload.resources : [])
        .filter((entry) => !entry?.deletedAt)
        .map(publicResourceView);
    return { resources };
}

export async function removeRoomResource(context, { roomId, resourceId, authInfo = null }, deps) {
    let removed = null;
    await deps.mutateMeeting(context, roomId, (_record, payload, stageEvent) => {
        const resources = Array.isArray(payload.resources) ? payload.resources : [];
        const resource = resources.find((entry) => String(entry?.resourceId || '') === String(resourceId || '') && !entry?.deletedAt);
        if (!resource) {
            throw new Error('Resource not found.');
        }
        resource.deletedAt = nowIso();
        removed = publicResourceView(resource);
        stageEvent('meeting', WEBMEET_EVENT_TYPES.RESOURCE_REMOVED, {
            meetingId: roomId,
            roomId,
            resourceId: resource.resourceId
        });
    });
    return { ok: Boolean(removed), resourceId };
}
