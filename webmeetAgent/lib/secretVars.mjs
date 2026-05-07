export function parseSecrets(_workspaceRoot) {
    return {};
}

export function resolveVarValue(_workspaceRoot, name) {
    const value = process.env[name];
    return value && String(value).trim() ? String(value).trim() : '';
}

export function setEnvVar(workspaceRoot, name, value) {
    throw new Error('Writing plaintext .ploinky/.secrets from WebMeet is disabled.');
}
