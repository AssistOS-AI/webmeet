export function normalizeAuthInfo(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') {
        return {
            id: '',
            username: '',
            email: '',
            principalId: '',
            roles: []
        };
    }
    const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const agent = authInfo.agent && typeof authInfo.agent === 'object' ? authInfo.agent : null;
    return {
        id: String(user.id || '').trim(),
        username: String(user.username || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(agent?.principalId || authInfo.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
}

export function isAdminAuthInfo(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    const roleMatch = normalized.roles.some((role) => String(role || '').trim().toLowerCase() === 'admin');
    if (roleMatch) {
        return true;
    }
    return normalized.username.toLowerCase() === 'admin'
        || normalized.id === 'local:admin'
        || normalized.principalId === 'user:local:admin';
}

export function isGuestAuthInfo(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    return normalized.roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
}

function hasAuthenticatedPrincipal(authInfo = null) {
    const normalized = normalizeAuthInfo(authInfo);
    return Boolean(normalized.id || normalized.principalId);
}

export function assertAdminAuthInfo(authInfo = null) {
    if (!isAdminAuthInfo(authInfo)) {
        throw new Error('Access denied: only admin can manage rooms.');
    }
}

export function assertAuthenticatedAuthInfo(authInfo = null) {
    if (!hasAuthenticatedPrincipal(authInfo)) {
        throw new Error('Access denied: authentication is required.');
    }
}

export function getAuthDisplayName(authInfo = null) {
    const user = authInfo && typeof authInfo === 'object'
        ? (authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo)
        : null;
    if (!user) return '';
    return String(user.name || user.username || user.email || '').trim();
}

function getInvocationScopes(authInfo = null) {
    return Array.isArray(authInfo?.invocation?.scope)
        ? authInfo.invocation.scope.map((scope) => String(scope || '').trim()).filter(Boolean)
        : [];
}

export function hasWebmeetRoomScope(authInfo = null, roomId = '') {
    const targetRoomId = String(roomId || '').trim();
    if (!targetRoomId) return false;
    const accepted = new Set([
        `webmeet:room:${targetRoomId}`,
        `public:webmeet:room:${targetRoomId}`
    ]);
    return getInvocationScopes(authInfo).some((scope) => accepted.has(scope));
}

function hasAnyWebmeetRoomScope(authInfo = null) {
    return getInvocationScopes(authInfo).some((scope) => (
        /^webmeet:room:room_[0-9a-fA-F-]{36}$/.test(scope)
        || /^public:webmeet:room:room_[0-9a-fA-F-]{36}$/.test(scope)
    ));
}

export function isMeetingRecordOpen(record) {
    return String(record?.status || '').trim().toLowerCase() !== 'archived'
        && !String(record?.archivedAt || '').trim();
}

export function canViewMeetingRecord(record, authInfo = null) {
    if (!hasAuthenticatedPrincipal(authInfo)) {
        return false;
    }
    if (isGuestAuthInfo(authInfo)) {
        return isMeetingRecordOpen(record) && String(record?.roomType || '').trim() === 'guest';
    }
    if (!isMeetingRecordOpen(record)) {
        return isAdminAuthInfo(authInfo);
    }
    const roomId = String(record?.meetingId || record?.roomId || '').trim();
    if (hasAnyWebmeetRoomScope(authInfo)) {
        return hasWebmeetRoomScope(authInfo, roomId);
    }
    return true;
}
