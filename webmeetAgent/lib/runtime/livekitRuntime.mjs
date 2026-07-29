import crypto from 'node:crypto';

import { resolvePrivateLiveKitCall } from './edgeRuntime.mjs';

export function createLiveKitToken(context, { roomName, identity, name, attributes = null, metadata = '' }) {
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
            canPublishData: true,
            canUpdateOwnMetadata: true
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
            roomAdmin: true,
            roomCreate: true
        }
    })).toString('base64url');
    const signature = crypto
        .createHmac('sha256', context.livekitApiSecret)
        .update(`${header}.${payload}`)
        .digest('base64url');
    return `${header}.${payload}.${signature}`;
}

async function callLiveKitRoomApi(context, methodName, roomName, body) {
    if (!context.livekitApiKey || !context.livekitApiSecret) {
        throw new Error('LiveKit room API is not configured.');
    }
    const token = createLiveKitRoomAdminToken(context, roomName);
    if (!token) {
        throw new Error('LiveKit admin token could not be created.');
    }
    const requestBody = Buffer.from(JSON.stringify(body || {}));
    const privateCall = typeof context.resolvePrivateLiveKitCall === 'function'
        ? await context.resolvePrivateLiveKitCall({ methodName, body: requestBody })
        : await resolvePrivateLiveKitCall({ methodName, body: requestBody });
    const response = await fetch(privateCall.url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Ploinky-Agent-Assertion': privateCall.assertion
        },
        body: requestBody
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
        const error = new Error(`LiveKit room API failed: ${detail}`);
        error.liveKitCode = String(parsed?.code || '').trim().toLowerCase();
        error.httpStatus = Number(response.status || 0);
        throw error;
    }
    return parsed || {};
}

function isMissingLiveKitRoom(error) {
    return String(error?.liveKitCode || '').trim().toLowerCase() === 'not_found'
        && Number(error?.httpStatus || 0) === 404;
}

export async function closeLiveKitRoom(context, roomName, { strict = false } = {}) {
    try {
        if (typeof context.closeLiveKitRoom === 'function') {
            return await context.closeLiveKitRoom(roomName);
        }
        return await callLiveKitRoomApi(context, 'DeleteRoom', roomName, { room: roomName });
    } catch (error) {
        if (isMissingLiveKitRoom(error)) {
            return { ok: true, alreadyClosed: true };
        }
        if (strict) {
            throw error;
        }
        return null;
    }
}

export async function removeLiveKitRoomParticipant(context, roomName, participantIdentity, { strict = false } = {}) {
    try {
        if (typeof context.removeLiveKitParticipant === 'function') {
            return await context.removeLiveKitParticipant(roomName, participantIdentity);
        }
        return await callLiveKitRoomApi(context, 'RemoveParticipant', roomName, {
            room: roomName,
            identity: participantIdentity
        });
    } catch (error) {
        if (strict) {
            throw error;
        }
        return null;
    }
}

export function getParticipantAttributes(participant) {
    return participant?.attributes && typeof participant.attributes === 'object' ? participant.attributes : {};
}

export function parseLiveKitProfileAvatar(attributes = {}) {
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

export function getLiveKitParticipantIdentity(participant) {
    return String(participant?.identity || '').trim();
}

export function isLiveKitAgentParticipant(participant) {
    const attributes = getParticipantAttributes(participant);
    return String(participant?.kind || '').toUpperCase() === 'AGENT'
        || String(attributes.webmeetAgent || '').toLowerCase() === 'true';
}

export async function listLiveKitRoomParticipants(context, roomName) {
    if (typeof context.listLiveKitParticipants === 'function') {
        const participants = await context.listLiveKitParticipants(roomName);
        return Array.isArray(participants) ? participants : [];
    }
    const response = await callLiveKitRoomApi(context, 'ListParticipants', roomName, { room: roomName });
    return Array.isArray(response.participants) ? response.participants : [];
}
