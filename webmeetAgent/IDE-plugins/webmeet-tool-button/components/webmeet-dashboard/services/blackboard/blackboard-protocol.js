function nowIso() {
    return new Date().toISOString();
}

function randomMessageId() {
    if (globalThis.crypto?.randomUUID) {
        return `blackboard_${globalThis.crypto.randomUUID()}`;
    }
    return `blackboard_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function base64Encode(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64Decode(encoded) {
    const binary = atob(String(encoded || ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function buildBlackboardProtocolPayload(input = {}) {
    const roomId = String(input.roomId || '').trim();
    if (!roomId) {
        throw new Error('Missing blackboard protocol roomId.');
    }
    const boardId = String(input.boardId || '').trim();
    if (!boardId) {
        throw new Error('Missing blackboard protocol boardId.');
    }
    return {
        kind: String(input.kind || '').trim() === 'widget' ? 'widget' : 'blackboard',
        roomId,
        ownerParticipantId: String(input.ownerParticipantId || '').trim(),
        blackboardId: String(input.blackboardId || '').trim(),
        boardId,
        boardOwnerType: String(input.boardOwnerType || '').trim(),
        boardOwnerId: String(input.boardOwnerId || input.ownerParticipantId || '').trim(),
        boardVisibility: String(input.boardVisibility || '').trim(),
        messageId: String(input.messageId || randomMessageId()).trim(),
        version: Number.isFinite(input.version) ? input.version : 0,
        visibility: input.visibility || 'all',
        object: input.object || null,
        timestamp: String(input.timestamp || nowIso()).trim()
    };
}

export function encodeBlackboardProtocolMessage({ from = 'user:local', to = 'ALL', payload } = {}) {
    const cleanFrom = String(from || '').trim();
    const cleanTo = String(to || 'ALL').trim() || 'ALL';
    if (!cleanFrom) {
        throw new Error('Invalid blackboard protocol address.');
    }
    const cleanPayload = buildBlackboardProtocolPayload(payload || {});
    return `blackboard:${cleanFrom}:${cleanTo}:${base64Encode(JSON.stringify(cleanPayload))}`;
}

function splitAddressSegments(addresses) {
    if (addresses.endsWith(':ALL')) {
        return { from: addresses.slice(0, -4), to: 'ALL' };
    }
    for (const marker of [':user:', ':agent:', ':widget:', ':service:', ':policy:']) {
        const index = addresses.lastIndexOf(marker);
        if (index > 0) {
            return {
                from: addresses.slice(0, index),
                to: marker.slice(1) + addresses.slice(index + marker.length)
            };
        }
    }
    const index = addresses.lastIndexOf(':');
    if (index <= 0) {
        throw new Error('Invalid blackboard protocol address.');
    }
    return { from: addresses.slice(0, index), to: addresses.slice(index + 1) };
}

export function parseBlackboardProtocolMessage(message) {
    const raw = String(message || '').trim();
    if (!raw.startsWith('blackboard:')) {
        throw new Error('Invalid blackboard protocol message.');
    }
    const body = raw.slice('blackboard:'.length);
    const lastSeparator = body.lastIndexOf(':');
    if (lastSeparator <= 0) {
        throw new Error('Invalid blackboard protocol message.');
    }
    const addresses = body.slice(0, lastSeparator);
    const encoded = body.slice(lastSeparator + 1);
    const { from, to } = splitAddressSegments(addresses);
    return {
        encoded: raw,
        from,
        to,
        payload: buildBlackboardProtocolPayload(JSON.parse(base64Decode(encoded)))
    };
}
