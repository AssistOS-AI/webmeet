import crypto from 'node:crypto';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const DEK_BYTES = 32;

function toBase64(buffer) {
    return Buffer.from(buffer).toString('base64');
}

function fromBase64(value) {
    return Buffer.from(String(value || ''), 'base64');
}

function encryptWithKey(key, plaintextBuffer) {
    const iv = crypto.randomBytes(GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintextBuffer), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        iv: toBase64(iv),
        ciphertext: toBase64(ciphertext),
        authTag: toBase64(authTag)
    };
}

function decryptWithKey(key, record) {
    const iv = fromBase64(record?.iv);
    const ciphertext = fromBase64(record?.ciphertext);
    const authTag = fromBase64(record?.authTag);
    if (iv.length !== GCM_IV_BYTES || authTag.length !== GCM_TAG_BYTES) {
        throw new Error('invalid_encrypted_record');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function deriveMasterKey(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!raw) {
        throw new Error('missing_webmeet_master_key');
    }
    try {
        const candidate = Buffer.from(raw, 'base64');
        if (candidate.length === DEK_BYTES) {
            return candidate;
        }
    } catch (_) {
        // fall back
    }
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

export function createWrappedDek(masterKey) {
    const dek = crypto.randomBytes(DEK_BYTES);
    const wrapped = encryptWithKey(masterKey, dek);
    return { dek, wrapped };
}

export function unwrapDek(masterKey, wrappedRecord) {
    const dek = decryptWithKey(masterKey, wrappedRecord);
    if (dek.length !== DEK_BYTES) {
        throw new Error('invalid_wrapped_dek');
    }
    return dek;
}

export function encryptPayload(dek, payload) {
    return encryptWithKey(dek, Buffer.from(JSON.stringify(payload ?? {}), 'utf8'));
}

export function decryptPayload(dek, encryptedPayload) {
    return JSON.parse(decryptWithKey(dek, encryptedPayload).toString('utf8'));
}
