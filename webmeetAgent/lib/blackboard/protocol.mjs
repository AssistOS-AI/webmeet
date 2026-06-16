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
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(text, 'utf8').toString('base64');
    }
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (const byte of bytes) {
        binary += String.fromCharCode(byte);
    }
    return btoa(binary);
}

function base64Decode(encoded) {
    if (typeof Buffer !== 'undefined') {
        return Buffer.from(String(encoded || ''), 'base64').toString('utf8');
    }
    const binary = atob(String(encoded || ''));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

export function buildBlackboardProtocolPayload({
    kind = 'blackboard',
    roomId = '',
    ownerParticipantId = '',
    blackboardId = '',
    messageId = '',
    version = 0,
    visibility = 'all',
    object = null,
    timestamp = ''
} = {}) {
    const cleanKind = String(kind || '').trim() === 'widget' ? 'widget' : 'blackboard';
    const cleanRoomId = String(roomId || '').trim();
    if (!cleanRoomId) {
        throw new Error('Missing blackboard protocol roomId.');
    }
    return {
        kind: cleanKind,
        roomId: cleanRoomId,
        ownerParticipantId: String(ownerParticipantId || '').trim(),
        blackboardId: String(blackboardId || '').trim(),
        messageId: String(messageId || randomMessageId()).trim(),
        version: Number.isFinite(version) ? version : 0,
        visibility,
        object,
        timestamp: String(timestamp || nowIso()).trim()
    };
}

export function encodeBlackboardProtocolMessage({
    from = 'service:webmeetAgent',
    to = 'ALL',
    payload
} = {}) {
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
    return {
        from: addresses.slice(0, index),
        to: addresses.slice(index + 1)
    };
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
    if (!from || !to || !encoded) {
        throw new Error('Invalid blackboard protocol message.');
    }
    const payload = JSON.parse(base64Decode(encoded));
    return {
        encoded: raw,
        from,
        to,
        payload: buildBlackboardProtocolPayload(payload)
    };
}
