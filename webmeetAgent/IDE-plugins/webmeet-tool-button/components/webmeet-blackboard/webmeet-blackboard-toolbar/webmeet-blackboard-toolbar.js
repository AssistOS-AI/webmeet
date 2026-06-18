import { getBlackboardThemeOptions, resolveBlackboardThemeId } from '../webmeet-blackboard-theme-presets.js';

export class WebMeetBlackboardToolbar {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.busy = false;
        this.themeId = resolveBlackboardThemeId();
        this.themeOptions = getBlackboardThemeOptions();
        this.openMenu = '';
        this.menuSelections = {
            shape: { icon: 'rectangle', value: 'shape:rectangle' },
            line: { icon: 'line', value: 'line' },
            insert: { icon: 'quiz', value: 'quiz' }
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

    setState({ busy = false, themeId } = {}) {
        this.busy = busy;
        if (themeId) {
            this.themeId = resolveBlackboardThemeId({ theme: { id: themeId } });
        }
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
        this.closeMenu();
        this.emit('blackboard-add-widget', { type: normalizedType });
    }

    uploadImageWidget(_target) {
        if (_target?.disabled || this.busy) return;
        this.closeMenu();
        const input = this.element.querySelector('[data-image-upload-input]');
        input?.click?.();
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
        this.renderState();
    }

    closeMenu() {
        if (!this.openMenu) return;
        this.openMenu = '';
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
                trigger.classList.toggle('is-active', isOpen);
            }
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

    emit(type, detail) {
        this.element.dispatchEvent(new CustomEvent(type, {
            bubbles: true,
            composed: true,
            detail
        }));
    }
}
