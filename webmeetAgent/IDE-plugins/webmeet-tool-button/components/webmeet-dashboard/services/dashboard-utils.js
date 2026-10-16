export const WEBMEET_ROOMS_CATEGORY_ID = 'rooms';
export const WEBMEET_ROOMS_CATEGORY_NAME = 'Rooms';

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
        return null;
    }
    const actor = {
        id: String(user.id || '').trim(),
        username: String(user.username || user.name || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(user.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
    return actor.id ? actor : null;
}

export function getCurrentActorDisplayName() {
    const user = globalThis.assistOS?.user;
    if (!user || typeof user !== 'object') return '';
    const explicitName = String(user.name || user.username || '').trim();
    if (explicitName) return explicitName;
    const email = String(user.email || '').trim();
    return email && email !== 'local@example.com' ? email : '';
}

const WEBMEET_GUEST_DISPLAY_NAME_KEY = 'webmeet.guestDisplayName';

export function readStoredGuestDisplayName() {
    try {
        return String(window?.localStorage?.getItem(WEBMEET_GUEST_DISPLAY_NAME_KEY) || '').trim();
    } catch {
        return '';
    }
}

export function storeGuestDisplayName(displayName) {
    const value = String(displayName || '').trim();
    if (!value) return;
    try {
        window?.localStorage?.setItem(WEBMEET_GUEST_DISPLAY_NAME_KEY, value);
    } catch {
        // localStorage can be unavailable in private browsing; joining should still work.
    }
}

export async function requestGuestDisplayName() {
    const storedName = readStoredGuestDisplayName();
    const result = await assistOS.UI.showModal('webmeet-guest-entry-modal', {
        displayName: storedName,
        status: 'Enter your name to join this public room.'
    }, true);
    const displayName = String(result?.displayName || '').trim();
    if (displayName) {
        storeGuestDisplayName(displayName);
    }
    return displayName;
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

export function readRoomIdFromUrl() {
    try {
        const params = new URLSearchParams(String(window.location.search || ''));
        const roomId = String(params.get('roomId') || '').trim();
        return /^room_[0-9a-fA-F-]{36}$/.test(roomId) ? roomId : '';
    } catch {
        return '';
    }
}

export function readRoomIdFromExplorerHash() {
    try {
        const hash = String(window.location.hash || '');
        const queryStart = hash.indexOf('?');
        if (queryStart === -1) {
            return '';
        }
        const params = new URLSearchParams(hash.slice(queryStart + 1));
        const roomId = String(params.get('roomId') || '').trim();
        return /^room_[0-9a-fA-F-]{36}$/.test(roomId) ? roomId : '';
    } catch {
        return '';
    }
}

export function syncBrowserRoomUrl(roomId, options = {}) {
    const id = String(roomId || '').trim();
    if (!id || !/^room_[0-9a-fA-F-]{36}$/.test(id)) {
        return false;
    }
    if (typeof window === 'undefined' || !window.history || !window.location) {
        return false;
    }
    const currentPathname = String(window.location.pathname || '');
    const isStandaloneRoomLoader = currentPathname.endsWith('/roomLoader.html');
    const targetUrl = isStandaloneRoomLoader
        ? new URL(currentPathname, window.location.origin)
        : new URL('/explorer/index.html', window.location.origin);
    targetUrl.searchParams.set('roomId', id);
    if (!isStandaloneRoomLoader) {
        targetUrl.hash = 'webmeet-dashboard';
    }
    const targetPath = `${targetUrl.pathname}${targetUrl.search || ''}${targetUrl.hash || ''}`;
    const currentPath = `${window.location.pathname || ''}${window.location.search || ''}${window.location.hash || ''}`;
    if (currentPath === targetPath) {
        return false;
    }
    const replace = options.replace === true;
    const state = {
        ...(window.history.state && typeof window.history.state === 'object' ? window.history.state : {}),
        webmeetRoomId: id
    };
    if (replace) {
        window.history.replaceState(state, '', targetPath);
    } else {
        window.history.pushState(state, '', targetPath);
    }
    return true;
}
