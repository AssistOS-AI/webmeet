import { findMentionRanges } from './chat-autocomplete/index.js';

export function chatTextSegments(value, knownTokens = []) {
    const text = String(value || '');
    const ranges = [];
    for (const match of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"`]+/gi)) {
        let value = match[0].replace(/[.,;:!?]+$/, '');
        for (const [open, close] of [['(', ')'], ['[', ']'], ['{', '}']]) {
            while (value.endsWith(close) && value.split(close).length > value.split(open).length) value = value.slice(0, -1);
        }
        try {
            const url = new URL(/^www\./i.test(value) ? `https://${value}` : value);
            if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
            ranges.push({ start: match.index, end: match.index + value.length, type: 'link', value, href: url.href });
        } catch (_) { /* Leave malformed URLs as plain text. */ }
    }
    const known = new Set(knownTokens);
    for (const range of findMentionRanges(text)) {
        if (known.has(range.token) && !ranges.some((link) => range.start < link.end && range.end > link.start)) {
            ranges.push({ ...range, type: 'mention', value: range.token });
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    const segments = [];
    let cursor = 0;
    for (const range of ranges) {
        if (range.start > cursor) segments.push({ type: 'text', value: text.slice(cursor, range.start) });
        segments.push({ type: range.type, value: range.value, ...(range.href ? { href: range.href } : {}) });
        cursor = range.end;
    }
    if (cursor < text.length) segments.push({ type: 'text', value: text.slice(cursor) });
    return segments;
}

export function appendChatText(container, value, knownTokens) {
    const document = container.ownerDocument;
    for (const segment of chatTextSegments(value, knownTokens)) {
        if (segment.type === 'text') {
            container.append(document.createTextNode(segment.value));
            continue;
        }
        const node = document.createElement(segment.type === 'link' ? 'a' : 'strong');
        node.textContent = segment.value;
        node.className = segment.type === 'link' ? 'webmeet-chat-link' : 'webmeet-chat-mention';
        if (segment.type === 'link') {
            node.href = segment.href;
            node.target = '_blank';
            node.rel = 'noopener noreferrer';
        }
        container.append(node);
    }
}
