import { getBlackboardThemeOptions, resolveBlackboardThemeId } from '../webmeet-blackboard-theme-presets.js';

export class WebMeetBlackboardToolbar {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.busy = false;
        this.themeId = resolveBlackboardThemeId();
        this.themeOptions = getBlackboardThemeOptions();
        this.openMenu = '';
        this.pendingWidgetType = '';
        this.scriptaDocumentMenuOpen = false;
        this.scriptaOpenMenuOpen = false;
        this.scriptaWorkspaceEntries = null;
        this.scriptaWorkspaceLoading = false;
        this.menuSelections = {
            shape: { icon: 'rectangle', value: 'shape:rectangle' },
            line: { icon: 'line', value: 'line' },
            insert: { icon: 'poll', value: 'poll' }
        };
        this.handleChange = (event) => this.handleToolbarChange(event);
        this.handleDocumentPointerDown = (event) => this.handleOutsideClick(event);
        this.handleDocumentKeydown = (event) => this.handleKeydown(event);
        this.element.setState = (state) => this.setState(state);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.bindEvents();
        this.renderState();
    }

    setState({ busy = false, themeId, pendingWidgetType, scriptaWorkspaceEntries, scriptaWorkspaceLoading } = {}) {
        this.busy = busy;
        if (themeId) {
            this.themeId = resolveBlackboardThemeId({ theme: { id: themeId } });
        }
        if (pendingWidgetType !== undefined) {
            this.pendingWidgetType = String(pendingWidgetType || '').trim();
        }
        if (scriptaWorkspaceEntries !== undefined) this.scriptaWorkspaceEntries = scriptaWorkspaceEntries;
        if (scriptaWorkspaceLoading !== undefined) this.scriptaWorkspaceLoading = Boolean(scriptaWorkspaceLoading);
        if (this.busy) {
            this.openMenu = '';
        }
        this.renderState();
    }

    bindEvents() {
        this.element.removeEventListener('change', this.handleChange);
        this.element.addEventListener('change', this.handleChange);
        document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
        document.addEventListener('pointerdown', this.handleDocumentPointerDown);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
        document.addEventListener('keydown', this.handleDocumentKeydown);
    }

    afterUnload() {
        document.removeEventListener('pointerdown', this.handleDocumentPointerDown);
        document.removeEventListener('keydown', this.handleDocumentKeydown);
    }

    addWidget(_target, type = 'shape') {
        const normalizedType = String(type || 'shape').trim() || 'shape';
        if (_target?.disabled) return;
        this.rememberMenuSelection(_target, normalizedType);
        this.pendingWidgetType = normalizedType;
        this.closeMenu();
        this.emit('blackboard-add-widget', { type: normalizedType });
        this.renderState();
    }

    uploadImageWidget(_target) {
        if (_target?.disabled || this.busy) return;
        this.closeMenu();
        const input = this.element.querySelector('[data-image-upload-input]');
        input?.click?.();
    }

    toggleScriptaDocumentMenu(_target) {
        if (_target?.disabled || this.busy) return;
        this.rememberMenuSelection(_target, 'scripta-document');
        this.scriptaDocumentMenuOpen = !this.scriptaDocumentMenuOpen;
        this.scriptaOpenMenuOpen = false;
        if (this.scriptaDocumentMenuOpen) {
            this.scriptaWorkspaceLoading = true;
            this.emit('blackboard-scripta-document', { operation: 'list' });
        }
        this.renderState();
    }

    toggleScriptaOpenMenu(_target) {
        if (_target?.disabled || this.busy) return;
        this.scriptaOpenMenuOpen = !this.scriptaOpenMenuOpen;
        this.renderState();
    }

    runScriptaMenuAction(_target, operation = '') {
        if (_target?.disabled || this.busy) return;
        const normalizedOperation = String(operation || '').trim();
        const documentPath = String(_target?.dataset?.scriptaPath || '').trim();
        this.closeMenu();
        this.emit('blackboard-scripta-document', {
            operation: normalizedOperation,
            ...(documentPath ? { path: documentPath } : {})
        });
    }

    runToolbarAction(_target, action = '') {
        const normalizedAction = String(action || '').trim();
        if (!normalizedAction || _target?.disabled) return;
        this.closeMenu();
        this.emit('blackboard-action', { action: normalizedAction });
    }

    selectTheme(_target, themeId = '') {
        const normalizedThemeId = resolveBlackboardThemeId({ theme: { id: themeId } });
        if (!normalizedThemeId || _target?.disabled || this.busy) return;
        this.themeId = normalizedThemeId;
        this.closeMenu();
        this.emit('blackboard-theme', { themeId: normalizedThemeId });
    }

    toggleMenu(_target, menu = '') {
        const normalizedMenu = String(menu || '').trim();
        if (!normalizedMenu || _target?.disabled || this.busy) return;
        this.openMenu = this.openMenu === normalizedMenu ? '' : normalizedMenu;
        if (this.openMenu !== 'insert') {
            this.scriptaDocumentMenuOpen = false;
            this.scriptaOpenMenuOpen = false;
        }
        this.renderState();
    }

    closeMenu() {
        if (!this.openMenu && !this.scriptaDocumentMenuOpen && !this.scriptaOpenMenuOpen) return;
        this.openMenu = '';
        this.scriptaDocumentMenuOpen = false;
        this.scriptaOpenMenuOpen = false;
        this.renderState();
    }

    handleOutsideClick(event) {
        if (!this.openMenu) return;
        if (this.element.contains(event.target)) return;
        this.closeMenu();
    }

    handleKeydown(event) {
        if (event.key !== 'Escape' || !this.openMenu) return;
        this.closeMenu();
    }

    handleToolbarChange(event) {
        const imageInput = event.target?.closest?.('[data-image-upload-input]');
        if (imageInput && this.element.contains(imageInput)) {
            const file = imageInput.files?.[0] || null;
            imageInput.value = '';
            if (file) {
                this.closeMenu();
                this.emit('blackboard-image-upload', { file });
            }
        }
    }

    rememberMenuSelection(target, type) {
        const menuItem = target?.closest?.('[data-menu-group]');
        const group = String(menuItem?.dataset?.menuGroup || '').trim();
        if (!group || !this.menuSelections[group]) return;
        this.menuSelections[group] = {
            icon: String(menuItem.dataset.menuIconValue || '').trim() || this.menuSelections[group].icon,
            value: String(menuItem.dataset.menuValue || type || '').trim() || this.menuSelections[group].value
        };
    }

    renderState() {
        for (const button of this.element.querySelectorAll('button')) {
            button.disabled = Boolean(this.busy);
        }
        for (const menu of this.element.querySelectorAll('[data-menu]')) {
            const menuName = String(menu.dataset.menu || '').trim();
            const isOpen = Boolean(menuName && menuName === this.openMenu && !this.busy);
            menu.classList.toggle('is-open', isOpen);
            const trigger = menu.querySelector('.webmeet-blackboard-menu-trigger');
            if (trigger) {
                trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
                const selectedInMenu = this.menuSelections[menuName]?.value === this.pendingWidgetType;
                trigger.classList.toggle('is-active', isOpen || selectedInMenu);
            }
        }
        for (const button of this.element.querySelectorAll('[data-local-action^="addWidget"]')) {
            const action = String(button.dataset.localAction || '').trim();
            const [, type = ''] = action.split(/\s+/, 2);
            button.classList.toggle('is-active', Boolean(type && type === this.pendingWidgetType));
        }
        for (const [group, selection] of Object.entries(this.menuSelections)) {
            const icon = this.element.querySelector(`[data-menu-icon="${group}"]`);
            if (icon) {
                icon.dataset.iconKey = selection.icon;
            }
        }
        for (const item of this.element.querySelectorAll('[data-menu-group][data-menu-value]')) {
            const group = String(item.dataset.menuGroup || '').trim();
            const selectedValue = this.menuSelections[group]?.value || '';
            item.classList.toggle('is-selected', item.dataset.menuValue === selectedValue);
        }
        const documentBranch = this.element.querySelector('[data-scripta-branch="document"]');
        const openBranch = this.element.querySelector('[data-scripta-branch="open"]');
        documentBranch?.classList.toggle('is-open', this.scriptaDocumentMenuOpen && this.openMenu === 'insert');
        openBranch?.classList.toggle('is-open', this.scriptaOpenMenuOpen && this.scriptaDocumentMenuOpen && this.openMenu === 'insert');
        documentBranch?.querySelector(':scope > button')?.setAttribute('aria-expanded', this.scriptaDocumentMenuOpen ? 'true' : 'false');
        openBranch?.querySelector(':scope > button')?.setAttribute('aria-expanded', this.scriptaOpenMenuOpen ? 'true' : 'false');
        this.renderScriptaOpenDocuments();
        const themeMenu = this.element.querySelector('[data-theme-menu]');
        if (themeMenu) {
            const fragment = document.createDocumentFragment();
            for (const option of this.themeOptions) {
                const selected = option.id === this.themeId;
                const button = document.createElement('button');
                button.type = 'button';
                button.className = `webmeet-blackboard-menu-item webmeet-blackboard-theme-item${selected ? ' is-selected' : ''}`;
                button.dataset.localAction = `selectTheme ${option.id}`;
                button.setAttribute('role', 'menuitemradio');
                button.setAttribute('aria-checked', selected ? 'true' : 'false');
                button.disabled = Boolean(this.busy);

                const check = document.createElement('span');
                check.className = 'webmeet-blackboard-theme-check';
                check.setAttribute('aria-hidden', 'true');
                check.textContent = selected ? '✓' : '';

                const label = document.createElement('span');
                label.textContent = option.label;

                button.append(check, label);
                fragment.append(button);
            }
            themeMenu.replaceChildren(fragment);
        }
    }

    renderScriptaOpenDocuments() {
        const menu = this.element.querySelector('[data-scripta-open-documents]');
        if (!menu) return;
        const fragment = document.createDocumentFragment();
        const entries = this.scriptaWorkspaceEntries;
        if (this.scriptaWorkspaceLoading) {
            const loading = document.createElement('span');
            loading.className = 'webmeet-blackboard-submenu-status';
            loading.textContent = 'Loading…';
            fragment.append(loading);
        } else if (!entries) {
            const unavailable = document.createElement('span');
            unavailable.className = 'webmeet-blackboard-submenu-status';
            unavailable.textContent = 'Workspace unavailable';
            fragment.append(unavailable);
        } else {
            const documents = Array.isArray(entries.defaultDocuments) ? entries.defaultDocuments : [];
            if (!documents.length) {
                const empty = document.createElement('span');
                empty.className = 'webmeet-blackboard-submenu-status';
                empty.textContent = 'No documents in room folder';
                fragment.append(empty);
            }
            for (const documentPath of documents) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'webmeet-blackboard-menu-item';
                button.dataset.localAction = 'runScriptaMenuAction open-path';
                button.dataset.scriptaPath = documentPath;
                button.setAttribute('role', 'menuitem');
                const icon = document.createElement('span');
                icon.className = 'webmeet-blackboard-menu-item-icon';
                icon.dataset.iconKey = 'scripta-document';
                const label = document.createElement('span');
                label.textContent = documentPath.split('/').pop() || documentPath;
                button.append(icon, label);
                fragment.append(button);
            }
            const other = document.createElement('button');
            other.type = 'button';
            other.className = 'webmeet-blackboard-menu-item webmeet-blackboard-menu-other';
            other.dataset.localAction = 'runScriptaMenuAction open-other';
            other.setAttribute('role', 'menuitem');
            const icon = document.createElement('span');
            icon.className = 'webmeet-blackboard-menu-item-icon';
            icon.dataset.iconKey = 'folder-open';
            const label = document.createElement('span');
            label.textContent = 'Other…';
            other.append(icon, label);
            fragment.append(other);
        }
        menu.replaceChildren(fragment);
    }

    emit(type, detail) {
        this.element.dispatchEvent(new CustomEvent(type, {
            bubbles: true,
            composed: true,
            detail
        }));
    }
}
