import fs from 'node:fs';
import path from 'node:path';

function getSecretsFile(workspaceRoot) {
    return path.join(workspaceRoot, '.ploinky', '.secrets');
}

function ensureSecretsFile(workspaceRoot) {
    const secretsFile = getSecretsFile(workspaceRoot);
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    return secretsFile;
}

export function parseSecrets(workspaceRoot) {
    const secretsFile = ensureSecretsFile(workspaceRoot);
    const map = {};
    try {
        const raw = fs.readFileSync(secretsFile, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line || line.trim().startsWith('#')) continue;
            const idx = line.indexOf('=');
            if (idx <= 0) continue;
            const key = line.slice(0, idx).trim();
            const value = line.slice(idx + 1);
            if (key) map[key] = value;
        }
    } catch (_) {
        // ignore
    }
    return map;
}

function resolveAlias(value, secrets, seen = new Set()) {
    if (typeof value !== 'string' || !value.startsWith('$')) {
        return value;
    }
    const ref = value.slice(1);
    if (!ref || seen.has(ref)) return '';
    seen.add(ref);
    return resolveAlias(secrets[ref], secrets, seen);
}

export function resolveVarValue(workspaceRoot, name) {
    const secrets = parseSecrets(workspaceRoot);
    const raw = secrets[name];
    if (raw === undefined) return '';
    return resolveAlias(raw, secrets);
}

export function setEnvVar(workspaceRoot, name, value) {
    throw new Error('Writing plaintext .ploinky/.secrets from WebMeet is disabled.');
}
