const MAX_INFLIGHT_CACHE = 16;

function sanitizeBrowserToken(token) {
    const raw = String(token || '').trim();
    if (!raw) return { folder: '', leaf: '' };
    if (raw.includes('\0')) return null;
    const body = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
    const normalized = body.replace(/\\+/g, '/');
    if (normalized.startsWith('/')) return null;
    if (normalized.split('/').some((segment) => segment === '..')) return null;
    const lastSlash = normalized.lastIndexOf('/');
    if (lastSlash === -1) return { folder: '', leaf: normalized };
    return {
        folder: normalized.slice(0, lastSlash),
        leaf: normalized.slice(lastSlash + 1)
    };
}

function tokenRangeForAt(value, triggerInfo) {
    const inputValue = typeof value === 'string' ? value : '';
    const fallbackIdx = inputValue.lastIndexOf('@');
    const triggerIdx = Number.isInteger(triggerInfo?.triggerIndex)
        ? triggerInfo.triggerIndex
        : fallbackIdx;
    if (triggerIdx < 0 || inputValue.charAt(triggerIdx) !== '@') {
        return null;
    }
    const afterTrigger = inputValue.slice(triggerIdx + 1);
    const stopMatch = afterTrigger.match(/\s/);
    const tokenEnd = stopMatch
        ? triggerIdx + 1 + stopMatch.index
        : triggerIdx + 1 + afterTrigger.length;
    return { triggerIdx, tokenEnd };
}

export function applyWorkspacePathSelection(value, relativePath, kind, triggerInfo = null) {
    const inputValue = typeof value === 'string' ? value : '';
    const range = tokenRangeForAt(inputValue, triggerInfo);
    if (!range) return null;
    const sanitized = String(relativePath || '').replace(/^\/+/, '');
    if (!sanitized) return null;
    const tokenBody = `file:${sanitized}`;
    const insertText = kind === 'folder' ? `@${tokenBody}/` : `@${tokenBody} `;
    const tail = inputValue.slice(range.tokenEnd);
    const tailStart = insertText.endsWith(' ') && /\s/.test(tail.charAt(0))
        ? range.tokenEnd + 1
        : range.tokenEnd;
    const next = inputValue.slice(0, range.triggerIdx) + insertText + inputValue.slice(tailStart);
    return {
        value: next,
        cursor: range.triggerIdx + insertText.length,
        token: `@${tokenBody}`
    };
}

function pathPieces(relativePath) {
    const trimmed = String(relativePath || '').replace(/^\/+/, '');
    const lastSlash = trimmed.lastIndexOf('/');
    if (lastSlash === -1) return { displayPath: trimmed, label: trimmed };
    return { displayPath: trimmed, label: trimmed.slice(lastSlash + 1) };
}

export function createWorkspacePathsProvider({ searchPaths } = {}) {
    if (typeof searchPaths !== 'function') {
        return null;
    }
    let cachedItems = [];
    let cachedKey = '';
    let pendingKey = '';
    const seenKeys = new Map();

    async function fetchSuggestions(folder, leaf) {
        const key = `${folder}::${leaf}`;
        if (key === cachedKey) return cachedItems;
        if (seenKeys.has(key)) return seenKeys.get(key);
        if (pendingKey === key) return cachedItems;
        pendingKey = key;
        try {
            const query = folder ? `${folder}/${leaf || ''}` : (leaf || '');
            const items = await searchPaths(query);
            const safeItems = Array.isArray(items) ? items : [];
            cachedItems = safeItems;
            cachedKey = key;
            if (seenKeys.size >= MAX_INFLIGHT_CACHE) {
                const firstKey = seenKeys.keys().next().value;
                if (firstKey !== undefined) seenKeys.delete(firstKey);
            }
            seenKeys.set(key, safeItems);
            return safeItems;
        } catch (_) {
            return [];
        } finally {
            pendingKey = '';
        }
    }

    function tokenFromTrigger(triggerInfo) {
        const token = String(triggerInfo?.token || '');
        if (!token) return { folder: '', leaf: '' };
        return sanitizeBrowserToken(token);
    }

    function getSuggestions(value, caret, triggerInfo) {
        if (triggerInfo?.trigger !== '@') return [];
        const parsed = tokenFromTrigger(triggerInfo);
        if (parsed === null) return [];
        const key = `${parsed.folder}::${parsed.leaf}`;
        if (key !== cachedKey) return [];
        const leafLower = parsed.leaf ? parsed.leaf.toLowerCase() : '';
        const matches = cachedItems.filter((item) => {
            if (!item || typeof item !== 'object') return false;
            const path = String(item.path || '').toLowerCase();
            if (!leafLower) return true;
            return path.includes(leafLower);
        });
        return matches.slice(0, 20).map((item) => {
            const kind = item.kind === 'folder' ? 'folder' : 'file';
            const relativePath = String(item.path || '').replace(/^\/+/, '');
            const { label, displayPath } = pathPieces(relativePath);
            return {
                label: kind === 'folder' ? `${displayPath.replace(/\/+$/, '')}/` : (displayPath || label),
                description: kind === 'folder' ? 'Folder' : 'File',
                group: 'Files and folders',
                keepMenuOpen: kind === 'folder',
                applySelection: (current, currentTriggerInfo) => applyWorkspacePathSelection(current, relativePath, kind, currentTriggerInfo)
            };
        });
    }

    function requestSuggestions(value, triggerInfo) {
        const parsed = tokenFromTrigger(triggerInfo);
        if (parsed === null) return Promise.resolve([]);
        return fetchSuggestions(parsed.folder, parsed.leaf);
    }

    return {
        trigger: '@',
        groupLabel: 'Files and folders',
        getSuggestions,
        requestSuggestions
    };
}
