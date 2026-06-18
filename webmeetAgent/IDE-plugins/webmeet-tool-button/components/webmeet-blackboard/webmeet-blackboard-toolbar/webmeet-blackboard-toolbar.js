import { getBlackboardThemeOptions, resolveBlackboardThemeId } from '../webmeet-blackboard-theme-presets.js';

const TEXT_DEFAULT_STYLE = {
    fontFamily: 'Arial',
    fontSize: 20,
    fontWeight: '400',
    fontStyle: 'normal',
    textColor: '#172033'
};
const TEXT_FONT_FAMILIES = ['Arial', 'Times New Roman', 'Georgia', 'Verdana', 'Courier New', 'Trebuchet MS'];

export class WebMeetBlackboardToolbar {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.activeTool = 'select';
        this.busy = false;
        this.background = { color: '#ffffff' };
        this.themeId = resolveBlackboardThemeId();
        this.themeOptions = getBlackboardThemeOptions();
        this.openMenu = '';
        this.selectedWidgetType = '';
        this.selectedTextWidget = null;
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

    setState({ activeTool = 'select', busy = false, background, themeId, selectedWidgetType = '', selectedTextWidget } = {}) {
        this.activeTool = activeTool;
        this.busy = busy;
        if (themeId) {
            this.themeId = resolveBlackboardThemeId({ theme: { id: themeId } });
        }
        this.selectedWidgetType = String(selectedWidgetType || '').trim();
        if (this.busy) {
            this.openMenu = '';
        }
        if (selectedTextWidget && selectedTextWidget.id && selectedTextWidget.style) {
            this.selectedTextWidget = {
                id: String(selectedTextWidget.id || ''),
                style: { ...TEXT_DEFAULT_STYLE, ...selectedTextWidget.style }
            };
        } else {
            this.selectedTextWidget = null;
        }
        if (background) {
            this.background = { ...this.background, ...background };
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

    setTool(_target, tool = 'select') {
        const normalizedTool = String(tool || 'select').trim() || 'select';
        if (_target?.disabled) return;
        this.closeMenu();
        this.emit('blackboard-tool', { tool: normalizedTool });
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

    runTextStyleAction(_target, action = '') {
        const normalizedAction = String(action || '').trim().toLowerCase();
        if (!normalizedAction || _target?.disabled || !this.selectedTextWidget?.id) return;
        const current = this.selectedTextWidget.style || {};
        const updatedStyle = { ...current };
        if (normalizedAction === 'bold') {
            const isBold = String(current.fontWeight || '').trim() === 'bold' || String(current.fontWeight || '') === '700';
            updatedStyle.fontWeight = isBold ? '400' : 'bold';
        } else if (normalizedAction === 'italic') {
            const isItalic = String(current.fontStyle || '').trim() === 'italic';
            updatedStyle.fontStyle = isItalic ? 'normal' : 'italic';
        } else {
            return;
        }
        this.emit('blackboard-text-style', {
            targetRef: this.selectedTextWidget.id,
            style: {
                fontWeight: updatedStyle.fontWeight,
                fontStyle: updatedStyle.fontStyle
            }
        });
        this.renderState();
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
        const backgroundColor = event.target?.closest?.('[data-background-color]');
        if (backgroundColor && this.element.contains(backgroundColor)) {
            this.closeMenu();
            this.emit('blackboard-background', { background: { color: backgroundColor.value } });
            return;
        }
        const textStyleControl = event.target?.closest?.('[data-text-style]');
        if (textStyleControl && this.element.contains(textStyleControl)) {
            this.emitTextStylePatch(textStyleControl);
            return;
        }
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

    emitTextStylePatch(control) {
        if (!control || this.busy || !this.selectedTextWidget?.id) return;
        const property = String(control.getAttribute('data-text-style') || '').trim();
        if (!property || !this.element?.contains(control)) return;
        const rawValue = String(control.value ?? '').trim();
        if (!rawValue) return;
        const patch = {};
        if (property === 'fontSize') {
            const size = Number.parseInt(rawValue, 10);
            if (!Number.isFinite(size) || size < 1) return;
            patch.fontSize = size;
        } else if (property === 'textColor') {
            if (/^#[0-9a-f]{6}$/i.test(rawValue)) {
                patch.textColor = rawValue.toLowerCase();
            } else {
                return;
            }
        } else {
            patch[property] = rawValue;
        }
        if (!Object.keys(patch).length) return;
        this.emit('blackboard-text-style', {
            targetRef: this.selectedTextWidget.id,
            style: patch
        });
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
        const textToolbar = this.element.querySelector('[data-text-toolbar]');
        const textToolbarSeparator = this.element.querySelector('[data-text-toolbar-separator]');
        const isText = this.selectedWidgetType === 'text' && Boolean(this.selectedTextWidget?.id);
        if (textToolbar) {
            textToolbar.hidden = !isText;
        }
        if (textToolbarSeparator) {
            textToolbarSeparator.hidden = !isText;
        }
        if (isText) {
            const style = this.selectedTextWidget.style || {};
            const fontFamily = String(style.fontFamily || TEXT_DEFAULT_STYLE.fontFamily).trim();
            const textColor = String(style.textColor || TEXT_DEFAULT_STYLE.textColor).trim();
            const fontSize = Number.isFinite(Number(style.fontSize)) ? Number(style.fontSize) : Number(TEXT_DEFAULT_STYLE.fontSize);
            const fontWeight = String(style.fontWeight || TEXT_DEFAULT_STYLE.fontWeight).trim();
            const fontStyle = String(style.fontStyle || TEXT_DEFAULT_STYLE.fontStyle).trim();
            const fontFamilyControl = this.element.querySelector('[data-text-style="fontFamily"]');
            const fontSizeControl = this.element.querySelector('[data-text-style="fontSize"]');
            const textColorControl = this.element.querySelector('[data-text-style="textColor"]');
            const boldButton = this.element.querySelector('[data-local-action="runTextStyleAction bold"]');
            const italicButton = this.element.querySelector('[data-local-action="runTextStyleAction italic"]');

            if (fontFamilyControl && TEXT_FONT_FAMILIES.includes(fontFamily)) {
                fontFamilyControl.value = fontFamily;
            }
            if (fontSizeControl) {
                fontSizeControl.value = String(fontSize);
            }
            if (textColorControl) {
                textColorControl.value = /^#[0-9a-f]{6}$/i.test(textColor) ? textColor : TEXT_DEFAULT_STYLE.textColor;
            }
            if (boldButton) {
                boldButton.classList.toggle('is-active', fontWeight === 'bold' || fontWeight === '700');
            }
            if (italicButton) {
                italicButton.classList.toggle('is-active', fontStyle === 'italic');
            }
        }
        for (const button of this.element.querySelectorAll('[data-local-action^="setTool "]')) {
            const [, tool = ''] = String(button.getAttribute('data-local-action') || '').trim().split(/\s+/);
            button.classList.toggle('is-active', tool === this.activeTool);
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
        const backgroundColor = this.element.querySelector('[data-background-color]');
        if (backgroundColor && backgroundColor.value !== this.background.color) {
            backgroundColor.value = this.background.color || '#ffffff';
        }
        const themeMenu = this.element.querySelector('[data-theme-menu]');
        if (themeMenu) {
            themeMenu.innerHTML = this.themeOptions.map((option) => {
                const selected = option.id === this.themeId;
                return `
                    <button type="button" class="webmeet-blackboard-menu-item webmeet-blackboard-theme-item ${selected ? 'is-selected' : ''}" data-local-action="selectTheme ${option.id}" role="menuitemradio" aria-checked="${selected ? 'true' : 'false'}" ${this.busy ? 'disabled' : ''}>
                        <span class="webmeet-blackboard-theme-check" aria-hidden="true">${selected ? '✓' : ''}</span>
                        <span>${option.label}</span>
                    </button>
                `;
            }).join('');
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
