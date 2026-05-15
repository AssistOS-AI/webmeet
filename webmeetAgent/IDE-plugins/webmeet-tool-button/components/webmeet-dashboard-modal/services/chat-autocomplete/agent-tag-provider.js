const TAG_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

export const WEBMEET_CANONICAL_AGENT_TAGS = Object.freeze([
    Object.freeze({
        tag: 'open-interpreter',
        label: '@open-interpreter',
        description: 'Research relay: Open Interpreter'
    })
]);

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

export function applyAgentTagSelection(value, tag, triggerInfo = null) {
    const inputValue = typeof value === 'string' ? value : '';
    if (!tag || !TAG_NAME_RE.test(tag)) return null;
    const range = tokenRangeForAt(inputValue, triggerInfo);
    if (!range) return null;
    const insertText = `@${tag} `;
    const tail = inputValue.slice(range.tokenEnd);
    const tailStart = insertText.endsWith(' ') && /\s/.test(tail.charAt(0))
        ? range.tokenEnd + 1
        : range.tokenEnd;
    const next = inputValue.slice(0, range.triggerIdx) + insertText + inputValue.slice(tailStart);
    return {
        value: next,
        cursor: range.triggerIdx + insertText.length,
        token: `@${tag}`
    };
}

function normalizeCatalog(rawEntries) {
    const seen = new Set();
    const entries = [];
    for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
        if (!raw || typeof raw !== 'object') continue;
        const tag = String(raw.tag || '').trim().replace(/^@+/, '').toLowerCase();
        if (!TAG_NAME_RE.test(tag) || seen.has(tag)) continue;
        seen.add(tag);
        entries.push({
            tag,
            label: String(raw.label || `@${tag}`),
            description: String(raw.description || '')
        });
    }
    return entries;
}

export function createAgentTagProvider({ tags = WEBMEET_CANONICAL_AGENT_TAGS } = {}) {
    const catalog = normalizeCatalog(tags);

    function getSuggestions(value, caret, triggerInfo) {
        if (triggerInfo?.trigger !== '@') return [];
        const token = String(triggerInfo.token || '');
        if (/[/\\]/.test(token)) return [];
        const normalized = token.trim().toLowerCase();
        const matches = catalog.filter((entry) => !normalized || entry.tag.includes(normalized));
        return matches.map((entry) => ({
            label: entry.label,
            description: entry.description,
            group: 'Agents',
            tokenPreview: `@${entry.tag}`,
            applySelection: (current, currentTriggerInfo) => applyAgentTagSelection(current, entry.tag, currentTriggerInfo)
        }));
    }

    function getKnownTokens() {
        return catalog.map((entry) => `@${entry.tag}`);
    }

    return {
        trigger: '@',
        groupLabel: 'Agents',
        getSuggestions,
        getKnownTokens,
        get catalog() {
            return catalog.slice();
        }
    };
}
