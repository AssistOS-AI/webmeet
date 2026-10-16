import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 1;

function deriveKey(secret, sessionId) {
    const seed = String(secret || '').trim();
    if (!seed) throw new Error('Meeting Secretary journal encryption key is not configured.');
    return crypto.hkdfSync('sha256', Buffer.from(seed), Buffer.from(String(sessionId)), Buffer.from('webmeet-scribe-journal-v1'), 32);
}

function safeSessionId(value) {
    const normalized = String(value || '').trim();
    if (!/^[a-zA-Z0-9_-]{8,200}$/.test(normalized)) throw new Error('Invalid meeting-notes session id.');
    return normalized;
}

export class EncryptedSessionJournal {
    constructor({ dataDir = '/data/sessions', secret = process.env.WEBMEET_SCRIBE_JOURNAL_KEY } = {}) {
        this.dataDir = path.resolve(dataDir);
        this.secret = String(secret || process.env.PLOINKY_AGENT_SECRET || '');
        this.writeQueue = Promise.resolve();
    }

    filePath(sessionId) {
        return path.join(this.dataDir, `${safeSessionId(sessionId)}.enc.json`);
    }

    async save(sessionId, state) {
        const serializedState = JSON.stringify(state);
        const operation = this.writeQueue.catch(() => {}).then(async () => {
            await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
            const iv = crypto.randomBytes(12);
            const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(this.secret, sessionId), iv);
            const plaintext = Buffer.from(serializedState);
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
            const payload = {
                version: FILE_VERSION,
                iv: iv.toString('base64'),
                tag: cipher.getAuthTag().toString('base64'),
                ciphertext: ciphertext.toString('base64'),
                updatedAt: new Date().toISOString(),
            };
            const target = this.filePath(sessionId);
            const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
            await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600 });
            await fs.rename(temporary, target);
        });
        this.writeQueue = operation;
        return operation;
    }

    async load(sessionId) {
        await this.writeQueue.catch(() => {});
        let payload;
        try {
            payload = JSON.parse(await fs.readFile(this.filePath(sessionId), 'utf8'));
        } catch (error) {
            if (error?.code === 'ENOENT') return null;
            throw error;
        }
        if (payload?.version !== FILE_VERSION) throw new Error('Unsupported meeting-notes journal version.');
        const decipher = crypto.createDecipheriv(
            'aes-256-gcm', deriveKey(this.secret, sessionId), Buffer.from(payload.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(payload.ciphertext, 'base64')),
            decipher.final(),
        ]);
        return JSON.parse(plaintext.toString('utf8'));
    }

    async remove(sessionId) {
        await this.writeQueue.catch(() => {});
        await fs.unlink(this.filePath(sessionId)).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
        });
    }

    async purgeOlderThan(maxAgeMs, now = Date.now()) {
        let entries = [];
        try { entries = await fs.readdir(this.dataDir, { withFileTypes: true }); } catch (error) {
            if (error?.code === 'ENOENT') return 0;
            throw error;
        }
        let removed = 0;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.enc.json')) continue;
            const target = path.join(this.dataDir, entry.name);
            const stat = await fs.stat(target);
            if ((now - stat.mtimeMs) <= maxAgeMs) continue;
            await fs.unlink(target);
            removed += 1;
        }
        return removed;
    }
}
