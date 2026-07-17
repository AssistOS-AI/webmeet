import crypto from 'node:crypto';

import { withVerifiedGuestParticipantOwner } from '../../lib/services/roomParticipants.mjs';

export function createGuestParticipantAuth(roomId, guestId = '') {
    const normalizedGuestId = String(guestId || crypto.randomUUID()).trim();
    const subject = `user:guest:${normalizedGuestId}`;
    return {
        invocation: {
            issuer: 'ploinky-router',
            subject,
            actor: { kind: 'guest', id: subject, roles: ['guest'] },
            caller: { kind: 'user', id: subject, roles: ['guest'] },
            scope: [`public:webmeet:room:${String(roomId || '').trim()}`],
            tool: 'webmeet_room_join_guest'
        }
    };
}

export async function withGuestParticipantOwner(context, roomId, callback, guestId = '') {
    return await withVerifiedGuestParticipantOwner(
        context,
        createGuestParticipantAuth(roomId, guestId),
        roomId,
        callback
    );
}
