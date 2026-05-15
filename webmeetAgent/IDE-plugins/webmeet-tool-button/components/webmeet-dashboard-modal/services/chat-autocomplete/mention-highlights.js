export function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function normalizeMentionToken(token) {
    const value = String(token || '').trim();
    if (!value.startsWith('@') || value.length < 2 || /\s/.test(value)) return '';
    return value;
}

function isStartBoundary(value, index) {
    if (index <= 0) return true;
    return /\s/.test(value.charAt(index - 1));
}

function isEndBoundary(value, index) {
    if (index >= value.length) return true;
    return /\s/.test(value.charAt(index));
}

function isDetectedEndBoundary(value, index) {
    if (isEndBoundary(value, index)) return true;
    return /[),;:!?]/.test(value.charAt(index));
}

export function extractMentionTokenAt(value, cursor) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return '';
    let pos = Number.isFinite(cursor) ? Math.max(0, Math.min(text.length, cursor)) : text.length;
    while (pos > 0 && /\s/.test(text.charAt(pos - 1))) {
        pos -= 1;
    }
    let start = pos;
    while (start > 0 && !/\s/.test(text.charAt(start - 1))) {
        start -= 1;
    }
    let end = pos;
    while (end < text.length && !/\s/.test(text.charAt(end))) {
        end += 1;
    }
    return normalizeMentionToken(text.slice(start, end));
}

export function findMentionRanges(value) {
    const text = typeof value === 'string' ? value : '';
    if (!text) return [];

    const mentionPattern = /@(?:file:[^\s<>()),;:!?]+|[A-Za-z][A-Za-z0-9_-]{0,63})/g;
    const ranges = [];
    for (const match of text.matchAll(mentionPattern)) {
        const token = normalizeMentionToken(match[0]);
        if (!token) continue;
        const start = match.index;
        const end = start + token.length;
        if (!isStartBoundary(text, start) || !isDetectedEndBoundary(text, end)) {
            continue;
        }
        ranges.push({ start, end, token });
    }
    return ranges;
}

function normalizeKnownTokens(tokens) {
    const unique = new Set();
    for (const raw of tokens || []) {
        const token = normalizeMentionToken(raw);
        if (token) unique.add(token);
    }
    return Array.from(unique).sort((a, b) => b.length - a.length);
}

export function renderMessageWithMentionHighlights(value, knownTokens) {
    const text = typeof value === 'string' ? value : '';
    const known = new Set(normalizeKnownTokens(knownTokens));
    if (!text) return '';

    const ranges = findMentionRanges(text);
    if (!ranges.length) return escapeHtml(text);

    let html = '';
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) {
            html += escapeHtml(text.slice(cursor, range.start));
        }
        if (known.has(range.token)) {
            html += `<strong class="webmeet-chat-mention">${escapeHtml(range.token)}</strong>`;
        } else {
            html += escapeHtml(range.token);
        }
        cursor = range.end;
    }
    if (cursor < text.length) {
        html += escapeHtml(text.slice(cursor));
    }
    return html;
}

export function renderComposerMentionOverlayHtml(value, selectedTokens) {
    const text = typeof value === 'string' ? value : '';
    const selected = normalizeKnownTokens(selectedTokens);
    if (!text) return '';

    let html = '';
    let index = 0;
    while (index < text.length) {
        const match = selected.find((token) => (
            text.startsWith(token, index)
            && isStartBoundary(text, index)
            && isEndBoundary(text, index + token.length)
        ));
        if (match) {
            html += `<strong class="webmeet-composer-mention">${escapeHtml(match)}</strong>`;
            index += match.length;
            continue;
        }
        html += escapeHtml(text.charAt(index));
        index += 1;
    }
    return html;
}
