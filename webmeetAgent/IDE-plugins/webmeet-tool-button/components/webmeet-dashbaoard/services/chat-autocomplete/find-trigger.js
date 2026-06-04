export function findTriggerAt(value, caretIndex, triggers) {
    const inputValue = typeof value === 'string' ? value : '';
    const safeCaret = Math.max(0, Math.min(inputValue.length, caretIndex));
    let best = null;
    for (const trigger of triggers || []) {
        const triggerChar = String(trigger || '');
        if (!triggerChar) continue;
        const idx = inputValue.lastIndexOf(triggerChar, Math.max(0, safeCaret - 1));
        if (idx === -1) continue;
        if (idx > 0) {
            const prev = inputValue.charAt(idx - 1);
            if (prev && !/\s/.test(prev) && prev !== '\n') continue;
        }
        const after = inputValue.slice(idx + 1, safeCaret);
        if (/[\n\r]/.test(after)) continue;
        if (!best || idx > best.triggerIndex) {
            best = { trigger: triggerChar, triggerIndex: idx, token: after };
        }
    }
    return best;
}
