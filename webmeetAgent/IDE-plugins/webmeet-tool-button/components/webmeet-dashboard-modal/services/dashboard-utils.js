export function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

export function formatDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString();
    } catch {
        return String(value);
    }
}

export function buildStableParticipantId(seed) {
    const base = String(seed || '').trim().toLowerCase();
    const safe = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safe) {
        return `participant-${Math.random().toString(36).slice(2, 10)}`;
    }
    return `participant-${safe}`;
}

export function createParticipantInstanceId() {
    try {
        if (typeof crypto?.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_) {
        // ignore and fallback
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeCurrentActor() {
    const user = globalThis.assistOS?.user;
    if (!user || typeof user !== 'object') {
        return {
            id: '',
            username: '',
            email: '',
            principalId: '',
            roles: []
        };
    }
    return {
        id: String(user.id || '').trim(),
        username: String(user.username || user.name || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(user.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
}

export function getCurrentActorDisplayName() {
    const user = globalThis.assistOS?.user;
    if (!user || typeof user !== 'object') return '';
    const explicitName = String(user.name || user.username || '').trim();
    if (explicitName) return explicitName;
    const email = String(user.email || '').trim();
    return email && email !== 'local@example.com' ? email : '';
}

export function isAdminActor(actor = null) {
    if (!actor || typeof actor !== 'object') return false;
    const roles = Array.isArray(actor.roles) ? actor.roles : [];
    const hasAdminRole = roles.some((role) => String(role || '').trim().toLowerCase() === 'admin');
    const usernameIsAdmin = String(actor.username || '').trim().toLowerCase() === 'admin'
        || String(actor.username || '').trim().toLowerCase().includes('admin');
    const idIsAdmin = String(actor.id || '').trim() === 'local:admin';
    const principalIdIsAdmin = String(actor.principalId || '').trim() === 'user:local:admin';

    return hasAdminRole || usernameIsAdmin || idIsAdmin || principalIdIsAdmin;
}

export function isMissingMeetingError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    return message.includes('meeting not found')
        || message.includes('enoent')
        || message.includes('no such file or directory');
}

function getGuestSessionKeyFromUrl() {
    const hash = String(window.location.hash || '');
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const params = new URLSearchParams(query);
    return String(params.get('guestSession') || '').trim();
}

export function readGuestSessionFromUrl() {
    const key = getGuestSessionKeyFromUrl();
    if (!key) return null;
    try {
        const raw = String(window.sessionStorage?.getItem(key) || '').trim();
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function buildPublicWebMeetApiBaseUrl() {
    return `${window.location.origin}/public-services/webmeet`;
}

export function buildAuthenticatedWebMeetApiBaseUrl() {
    return `${window.location.origin}/public-services/webmeet`;
}
