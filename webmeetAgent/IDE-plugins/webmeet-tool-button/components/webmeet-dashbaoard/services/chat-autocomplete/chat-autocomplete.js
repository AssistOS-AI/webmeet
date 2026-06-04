import { findTriggerAt } from './find-trigger.js';

const MENU_MAX_VISIBLE = 8;
const TRIGGERS = ['@'];

function clearChildren(node) {
    while (node && node.firstChild) {
        node.removeChild(node.firstChild);
    }
}

export function createChatAutocomplete(options = {}) {
    const {
        input,
        menuContainer,
        providers = [],
        onSelectionApplied
    } = options;
    if (!input) {
        throw new Error('createChatAutocomplete: input element is required.');
    }
    const container = menuContainer || input.parentElement || document.body;
    const providerList = Array.isArray(providers) ? providers.slice() : [];
    let menuEl = null;
    let active = false;
    let suggestionsCache = [];
    let selectedIndex = -1;
    let destroyed = false;

    function ensureMenuElement() {
        if (menuEl) return menuEl;
        menuEl = document.createElement('div');
        menuEl.className = 'webmeet-chat-suggest-menu';
        menuEl.setAttribute('role', 'listbox');
        menuEl.setAttribute('aria-label', 'Chat suggestions');
        menuEl.addEventListener('pointerdown', (event) => { event.preventDefault(); });
        container.appendChild(menuEl);
        return menuEl;
    }

    function hideMenu() {
        if (menuEl) {
            menuEl.style.display = 'none';
        }
        active = false;
        selectedIndex = -1;
        suggestionsCache = [];
    }

    function activeTrigger() {
        const value = input.value || '';
        const caret = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
        return findTriggerAt(value, caret, TRIGGERS);
    }

    function collectSuggestions(triggerInfo) {
        const value = input.value || '';
        const caret = typeof input.selectionStart === 'number' ? input.selectionStart : value.length;
        const matched = providerList.filter((provider) => provider.trigger === triggerInfo.trigger);
        const flat = [];
        const groupLabels = new Set();
        for (const provider of matched) {
            let suggestions = [];
            try {
                suggestions = provider.getSuggestions
                    ? provider.getSuggestions(value, caret, triggerInfo)
                    : [];
            } catch (_) {
                suggestions = [];
            }
            if (!Array.isArray(suggestions) || !suggestions.length) continue;
            const groupLabel = provider.groupLabel || provider.trigger;
            groupLabels.add(groupLabel);
            for (const suggestion of suggestions) {
                flat.push({
                    ...suggestion,
                    provider,
                    group: suggestion.group || groupLabel
                });
            }
        }
        return { flat, groupCount: groupLabels.size };
    }

    function applySelection(suggestion) {
        if (!suggestion) return;
        const value = input.value || '';
        const triggerInfo = activeTrigger();
        let next = null;
        if (typeof suggestion.applySelection === 'function') {
            next = suggestion.applySelection(value, triggerInfo);
        } else if (suggestion.provider && typeof suggestion.provider.applySelection === 'function') {
            next = suggestion.provider.applySelection(value, suggestion, triggerInfo);
        }
        if (!next || typeof next !== 'object') return;
        input.value = next.value;
        try {
            input.setSelectionRange(next.cursor, next.cursor);
        } catch (_) {
            // selection support is best-effort
        }
        if (typeof onSelectionApplied === 'function') {
            try {
                onSelectionApplied({ suggestion, next, previousValue: value, triggerInfo });
            } catch (_) {
                // ignore handler errors
            }
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        if (suggestion.keepMenuOpen) {
            active = true;
            renderMenu();
            return;
        }
        hideMenu();
    }

    function positionMenu() {
        if (!menuEl) return;
        menuEl.style.position = 'absolute';
        menuEl.style.left = '0px';
        menuEl.style.right = '0px';
        menuEl.style.bottom = `${input.offsetHeight + 8}px`;
    }

    function renderMenu() {
        if (destroyed || !input) {
            hideMenu();
            return;
        }
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
        const { flat, groupCount } = collectSuggestions(triggerInfo);
        if (!flat.length) {
            hideMenu();
            return;
        }
        suggestionsCache = flat;
        if (selectedIndex < 0 || selectedIndex >= suggestionsCache.length) {
            selectedIndex = 0;
        }
        active = true;

        const menu = ensureMenuElement();
        clearChildren(menu);

        const startIdx = selectedIndex >= MENU_MAX_VISIBLE
            ? selectedIndex - MENU_MAX_VISIBLE + 1
            : 0;
        const visible = suggestionsCache.slice(startIdx, startIdx + MENU_MAX_VISIBLE);

        const showGroupHeaders = groupCount > 1 || triggerInfo.trigger === '@';
        let lastGroup = null;

        visible.forEach((suggestion, idx) => {
            const absoluteIdx = idx + startIdx;
            if (showGroupHeaders && suggestion.group && suggestion.group !== lastGroup) {
                const header = document.createElement('div');
                header.className = 'webmeet-chat-suggest-group';
                header.textContent = suggestion.group;
                menu.appendChild(header);
                lastGroup = suggestion.group;
            }
            const item = document.createElement('div');
            item.className = 'webmeet-chat-suggest-item' + (absoluteIdx === selectedIndex ? ' is-active' : '');
            item.setAttribute('role', 'option');
            item.setAttribute('aria-selected', absoluteIdx === selectedIndex ? 'true' : 'false');
            const label = document.createElement('span');
            label.className = 'webmeet-chat-suggest-label';
            label.textContent = suggestion.label || '';
            const desc = document.createElement('span');
            desc.className = 'webmeet-chat-suggest-desc';
            desc.textContent = suggestion.description || '';
            item.appendChild(label);
            item.appendChild(desc);
            item.addEventListener('pointerdown', (event) => {
                event.preventDefault();
                event.stopPropagation();
                selectedIndex = absoluteIdx;
                applySelection(suggestionsCache[absoluteIdx]);
            });
            menu.appendChild(item);
        });

        positionMenu();
        menu.style.display = 'block';
    }

    function scheduleFetchAndRender() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
        const matched = providerList.filter((provider) => provider.trigger === triggerInfo.trigger);
        renderMenu();
        for (const provider of matched) {
            if (typeof provider.requestSuggestions !== 'function') continue;
            Promise.resolve()
                .then(() => provider.requestSuggestions(input.value || '', triggerInfo))
                .catch(() => null)
                .finally(() => {
                    if (!destroyed && input && activeTrigger()) {
                        renderMenu();
                    }
                });
        }
    }

    function onInputChange() {
        const triggerInfo = activeTrigger();
        if (!triggerInfo) {
            hideMenu();
            return;
        }
        scheduleFetchAndRender();
    }

    function handleKeydown(event) {
        if (!active || !menuEl || menuEl.style.display === 'none') return false;
        const length = suggestionsCache.length;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, length - 1);
            renderMenu();
            return true;
        }
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            renderMenu();
            return true;
        }
        if ((event.key === 'Enter' || event.key === 'Tab') && selectedIndex >= 0) {
            event.preventDefault();
            event.stopPropagation();
            applySelection(suggestionsCache[selectedIndex]);
            return true;
        }
        if (event.key === 'Escape') {
            event.preventDefault();
            hideMenu();
            return true;
        }
        return false;
    }

    const inputListener = () => onInputChange();
    const blurListener = () => {
        // Allow click selection to complete first; pointerdown preventDefault keeps focus.
        setTimeout(() => {
            if (document.activeElement !== input) hideMenu();
        }, 100);
    };
    input.addEventListener('input', inputListener);
    input.addEventListener('blur', blurListener);

    function destroy() {
        destroyed = true;
        input.removeEventListener('input', inputListener);
        input.removeEventListener('blur', blurListener);
        if (menuEl) {
            menuEl.remove();
            menuEl = null;
        }
        suggestionsCache = [];
    }

    return {
        onInputChange,
        handleKeydown,
        destroy,
        get isActive() { return active; }
    };
}
