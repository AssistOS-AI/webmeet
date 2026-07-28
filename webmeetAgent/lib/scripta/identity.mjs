import crypto from 'node:crypto';

export function scriptaOwnerHash(principalId = '') {
    const principal = String(principalId || '').trim();
    if (!principal) return '';
    return `participant-${crypto.createHash('sha256').update(principal).digest('hex').slice(0, 24)}`;
}
