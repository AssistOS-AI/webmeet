import { getBlackboardTheme, resolveBlackboardTheme } from '../webmeet-blackboard-theme-presets.js';
import { TEXT_DEFAULT_STYLE, TEXT_FONT_FAMILIES, TEXT_MIN_FONT_SIZE, TEXT_MAX_FONT_SIZE } from './webmeet-blackboard-text-style.js';

export const blackboardActionMethods = {
    async submitInteractiveWidget(widget, data) {
        if (!widget?.id || this.busy) return;
        await this.runFinalChange({
            changeType: 'submit',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'interactiveSubmit',
            data
        });
    },

    updateToolbarState() {
        this.toolbar?.setState?.({
            busy: this.busy,
            themeId: this.getBlackboardTheme().id
        });
    },

    getWidgetById(targetRef) {
        const normalizedTargetRef = String(targetRef || '').trim();
        if (!normalizedTargetRef || !Array.isArray(this.blackboard?.widgets)) return null;
        return this.blackboard.widgets.find((widget) => String(widget?.id || '') === normalizedTargetRef) || null;
    },

    normalizeTextStyle(style = {}, withDefaults = true) {
        const source = style || {};
        const normalized = {};
        const fontFamily = String(source.fontFamily || '').trim();
        if (TEXT_FONT_FAMILIES.includes(fontFamily)) {
            normalized.fontFamily = fontFamily;
        }
        const fontSize = Number.parseInt(String(source.fontSize || ''), 10);
        if (Number.isFinite(fontSize)) {
            normalized.fontSize = Math.max(TEXT_MIN_FONT_SIZE, Math.min(TEXT_MAX_FONT_SIZE, fontSize));
        }
        const fontWeight = String(source.fontWeight || '').trim().toLowerCase();
        if (fontWeight === 'normal' || fontWeight === '400') {
            normalized.fontWeight = '400';
        }
        if (fontWeight === 'bold' || fontWeight === '700') {
            normalized.fontWeight = '700';
        }
        if (source.fontStyle !== undefined) {
            const fontStyle = String(source.fontStyle || '').trim().toLowerCase();
            if (fontStyle === 'italic' || fontStyle === 'normal') {
                normalized.fontStyle = fontStyle;
            }
        }
        const textColor = String(source.textColor || '').trim();
        if (/^#[0-9a-f]{6}$/i.test(textColor)) {
            normalized.textColor = textColor.toLowerCase();
        }
        if (!withDefaults) {
            return normalized;
        }
        return {
            fontFamily: normalized.fontFamily || TEXT_DEFAULT_STYLE.fontFamily,
            fontSize: Number.isFinite(normalized.fontSize) ? normalized.fontSize : TEXT_DEFAULT_STYLE.fontSize,
            fontWeight: normalized.fontWeight || TEXT_DEFAULT_STYLE.fontWeight,
            fontStyle: normalized.fontStyle || TEXT_DEFAULT_STYLE.fontStyle,
            textColor: normalized.textColor || TEXT_DEFAULT_STYLE.textColor
        };
    },

    getBlackboardBackground() {
        const theme = this.getBlackboardTheme();
        return {
            color: theme.tokens.boardBackground,
            gridColor: theme.tokens.boardGridColor
        };
    },

    getBlackboardTheme() {
        return resolveBlackboardTheme(this.blackboard?.metadata || {});
    },

    applyBoardBackground() {
        if (!this.board) return;
        const theme = this.getBlackboardTheme();
        const background = this.getBlackboardBackground();
        this.board.dataset.blackboardTheme = theme.id;
        this.applyBoardThemeTokens(theme);
        this.board.style.setProperty('--bb-board-bg', background.color);
        this.board.style.setProperty('--bb-grid-color', background.gridColor);
    },

    applyBoardThemeTokens(theme) {
        const tokens = theme?.tokens || {};
        const tokenMap = {
            '--bb-panel-bg': tokens.panelBackground,
            '--bb-board-bg': tokens.boardBackground,
            '--bb-grid-color': tokens.boardGridColor,
            '--bb-board-border': tokens.boardBorder,
            '--bb-widget-bg': tokens.widgetSurface,
            '--bb-widget-text': tokens.widgetText,
            '--bb-widget-border': tokens.widgetBorder,
            '--bb-selection': tokens.selectionColor,
            '--bb-selection-shadow': tokens.selectionShadow,
            '--bb-resize-bg': tokens.resizeHandleSurface,
            '--bb-resize-border': tokens.selectionColor,
            '--bb-inline-edit-bg': tokens.inlineEditBackground,
            '--bb-context-bg': tokens.contextButtonSurface,
            '--bb-context-hover-bg': tokens.contextButtonHoverSurface,
            '--bb-context-text': tokens.contextButtonText,
            '--bb-danger': tokens.danger
        };
        for (const [property, value] of Object.entries(tokenMap)) {
            if (value) {
                this.element?.style?.setProperty(property, String(value));
                this.board.style.setProperty(property, String(value));
            }
        }
    },

    async setBlackboardTheme(themeId) {
        await this.flushInlineTextEdit();
        const theme = getBlackboardTheme(themeId);
        if (!theme?.id) return;
        await this.runFinalChange({
            changeType: 'update',
            targetType: 'blackboard',
            reason: 'theme',
            patch: {
                metadata: {
                    theme: { id: theme.id }
                },
                resetThemeStyles: true
            }
        });
    },

    async runFinalChange(change) {
        if (!this.adapter || this.busy) return null;
        this.busy = true;
        this.updateToolbarState();
        try {
            const response = await this.adapter.sendChange(change);
            if (response?.blackboard) {
                this.blackboard = response.blackboard;
                this.renderWidgets();
            }
            return response;
        } finally {
            this.busy = false;
            this.updateToolbarState();
        }
    },

    async addWidget(type) {
        await this.flushInlineTextEdit();
        const widget = this.createWidget(type);
        const response = await this.runFinalChange({
            changeType: 'create',
            targetType: 'widget',
            reason: 'toolbar',
            widget
        });
        if (response?.object?.id || widget?.id) {
            this.selection = response?.object?.id || widget.id;
            this.renderWidgets();
        }
    },

    async addImageWidgetFromFile(file) {
        await this.flushInlineTextEdit();
        if (!file || this.busy) return;
        const image = await this.loadBlackboardImageFile(file);
        if (!image?.url) return;
        const widget = this.createWidget('image');
        widget.properties = {
            ...widget.properties,
            source: {
                kind: 'blob',
                id: image.id,
                url: image.url,
                downloadUrl: image.url,
                localPath: image.localPath,
                mimeType: image.mimeType,
                name: image.name,
                size: image.size
            },
            alt: image.name,
            naturalSize: {
                width: image.width,
                height: image.height
            }
        };
        const ratio = image.width > 0 && image.height > 0 ? image.width / image.height : 4 / 3;
        const width = Math.min(360, Math.max(180, image.width || 240));
        widget.properties.geometry = {
            ...(widget.properties.geometry || {}),
            width,
            height: Math.round(width / ratio)
        };
        const response = await this.runFinalChange({
            changeType: 'create',
            targetType: 'widget',
            reason: 'imageUpload',
            widget
        });
        if (response?.object?.id || widget?.id) {
            this.selection = response?.object?.id || widget.id;
            this.renderWidgets();
        }
    },

    async loadBlackboardImageFile(file) {
        const mimeType = String(file?.type || '').trim();
        if (!mimeType.startsWith('image/')) {
            throw new Error('Selected file is not an image.');
        }
        const name = String(file?.name || 'Image').trim() || 'Image';
        const [upload, dimensions] = await Promise.all([
            this.uploadBlackboardImageBlob(file, name, mimeType),
            this.readImageDimensions(file)
        ]);
        return {
            id: upload.id,
            url: upload.url,
            localPath: upload.localPath,
            mimeType: upload.mimeType || mimeType,
            name: upload.name || name,
            size: upload.size,
            width: dimensions.width,
            height: dimensions.height
        };
    },

    async uploadBlackboardImageBlob(file, name, mimeType) {
        const response = await fetch('/blobs/webmeetAgent', {
            method: 'POST',
            headers: {
                'Content-Type': mimeType || 'application/octet-stream',
                'X-Mime-Type': mimeType || 'application/octet-stream',
                'X-File-Name': encodeURIComponent(name || 'image')
            },
            body: file
        });
        if (!response.ok) {
            const reason = await response.text().catch(() => '');
            throw new Error(reason || `Image upload failed (${response.status}).`);
        }
        const payload = await response.json().catch(() => ({}));
        const url = this.resolveUploadUrl(payload?.downloadUrl || payload?.localPath || '');
        if (!url) {
            throw new Error('Image upload did not return a usable URL.');
        }
        return {
            id: payload?.id || '',
            url,
            localPath: payload?.localPath || '',
            mimeType: payload?.mime || mimeType,
            name: payload?.filename || name,
            size: Number.isFinite(Number(payload?.size)) ? Number(payload.size) : Number(file?.size || 0)
        };
    },

    resolveUploadUrl(url) {
        const rawUrl = String(url || '').trim();
        if (!rawUrl) return '';
        try {
            return new URL(rawUrl, window.location.origin).href;
        } catch (_) {
            return rawUrl;
        }
    },

    readImageDimensions(file) {
        return new Promise((resolve, reject) => {
            const objectUrl = URL.createObjectURL(file);
            const image = new Image();
            image.onload = () => {
                const width = Number(image.naturalWidth || image.width || 320) || 320;
                const height = Number(image.naturalHeight || image.height || 240) || 240;
                URL.revokeObjectURL(objectUrl);
                resolve({ width, height });
            };
            image.onerror = () => {
                URL.revokeObjectURL(objectUrl);
                reject(new Error('Could not read selected image dimensions.'));
            };
            image.src = objectUrl;
        });
    },

    createWidget(type) {
        const rawType = String(type || 'shape').trim();
        const [normalizedType, variant] = rawType.split(':');
        const offset = (this.widgetCreateOffset % 8) * 18;
        this.widgetCreateOffset += 1;
        const baseGeometry = {x: 72 + offset, y: 64 + offset, width: 180, height: 96};
        const id = this.createWidgetId(normalizedType);
        const widget = {
            id,
            type: normalizedType,
            properties: {
                geometry: baseGeometry,
                style: {}
            },
            visibility: {mode: 'all'},
            locked: false
        };
        if (normalizedType === 'line') {
            widget.properties.geometry = {x: 72 + offset, y: 96 + offset, width: 220, height: 80};
            widget.properties.style = {};
            const angle = 340;
            widget.properties.line = {
                angle,
                ...this.getLineEndpoints(220, 80, angle),
                markerStart: variant === 'arrow-both' ? 'arrow' : '',
                markerEnd: variant === 'arrow-end' || variant === 'arrow-both' ? 'arrow' : ''
            };
            widget.properties.label = '';
        } else if (normalizedType === 'text') {
            widget.properties.style = {
                fontFamily: TEXT_DEFAULT_STYLE.fontFamily,
                fontSize: TEXT_DEFAULT_STYLE.fontSize,
                fontWeight: TEXT_DEFAULT_STYLE.fontWeight,
                fontStyle: TEXT_DEFAULT_STYLE.fontStyle
            };
            widget.properties.text = 'Text';
        } else if (normalizedType === 'quiz') {
            widget.properties = {
                ...widget.properties,
                prompt: 'Question',
                options: ['A', 'B', 'C'],
                participantData: {},
                aggregation: {},
                resultsVisibility: 'moderatorsOnly'
            };
        } else if (normalizedType === 'vote') {
            widget.properties = {
                ...widget.properties,
                prompt: 'Vote',
                options: ['Yes', 'No'],
                participantData: {},
                aggregation: {},
                resultsVisibility: 'public'
            };
        } else if (normalizedType === 'input') {
            widget.properties = {
                ...widget.properties,
                label: 'Input',
                participantData: {},
                aggregation: {},
                resultsVisibility: 'moderatorsOnly'
            };
        } else if (normalizedType === 'image') {
            widget.properties.geometry = {x: 72 + offset, y: 64 + offset, width: 320, height: 220};
            widget.properties.style = {
                fill: 'transparent'
            };
            widget.properties.source = null;
            widget.properties.alt = 'Image';
        } else {
            if (normalizedType === 'shape') {
                widget.properties.shapeKind = variant || 'rectangle';
            }
            widget.properties.label = '';
        }
        return widget;
    },

    createWidgetId(type) {
        if (globalThis.crypto?.randomUUID) {
            return `widget_${type}_${globalThis.crypto.randomUUID()}`;
        }
        return `widget_${type}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    },

    async deleteSelectedWidget() {
        await this.flushInlineTextEdit();
        const targetRef = String(this.selection || '').trim();
        if (!targetRef) return;
        await this.runFinalChange({
            changeType: 'delete',
            targetType: 'widget',
            targetRef,
            reason: 'toolbar'
        });
        this.selection = '';
        this.renderWidgets();
    },

    canRotateWidget(widget) {
        return !widget?.locked && ['shape', 'text', 'image'].includes(String(widget?.type || '').trim());
    },

    getWidgetRotation(widget) {
        const rotation = Number(widget?.properties?.rotation ?? widget?.properties?.geometry?.rotation ?? 0);
        if (!Number.isFinite(rotation)) return 0;
        return rotation;
    },

    async rotateWidgetByStep(widget, degrees = 15) {
        if (!widget?.id || !this.canRotateWidget(widget) || this.busy) return;
        const nextRotation = this.getWidgetRotation(widget) + Number(degrees || 0);
        this.selection = widget.id;
        await this.runFinalChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'rotate',
            patch: {
                properties: {
                    rotation: nextRotation
                }
            }
        });
    },

    async clearBlackboard() {
        await this.flushInlineTextEdit();
        if (!Array.isArray(this.blackboard?.widgets) || !this.blackboard.widgets.length) return;
        await this.runFinalChange({
            changeType: 'clear',
            targetType: 'blackboard',
            reason: 'toolbar'
        });
        this.selection = '';
        this.renderWidgets();
    },

    async undo() {
        await this.flushInlineTextEdit();
        if (!this.adapter || this.busy) return;
        this.busy = true;
        this.updateToolbarState();
        try {
            const response = await this.adapter.undo();
            if (response?.blackboard) {
                this.blackboard = response.blackboard;
                this.renderWidgets();
            }
        } finally {
            this.busy = false;
            this.updateToolbarState();
        }
    },

    async redo() {
        await this.flushInlineTextEdit();
        if (!this.adapter || this.busy) return;
        this.busy = true;
        this.updateToolbarState();
        try {
            const response = await this.adapter.redo();
            if (response?.blackboard) {
                this.blackboard = response.blackboard;
                this.renderWidgets();
            }
        } finally {
            this.busy = false;
            this.updateToolbarState();
        }
    },

    async editWidget(widget) {
        if (!widget || widget.locked) return;
        if (!globalThis.assistOS?.UI?.showModal) return;
        const result = await globalThis.assistOS.UI.showModal('webmeet-blackboard-widget-editor', {
            'widget-json': encodeURIComponent(JSON.stringify(widget))
        }, true);
        if (!result?.patch || !widget.id) return;
        await this.runFinalChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'settings',
            patch: result.patch
        });
    },

    getEditableWidgetProperty() {
        return 'text';
    },

    getEditableWidgetText(widget) {
        const property = this.getEditableWidgetProperty(widget);
        const value = widget?.properties?.[property];
        if (value !== undefined && value !== null) {
            return String(value);
        }
        return '';
    },

    startInlineTextEdit(widget) {
        if (!widget?.id || widget.locked || this.inlineEditWidgetId === widget.id) return;
        const node = this.widgetNodes.get(widget.id);
        const editable = node?.querySelector?.('.webmeet-blackboard-inline-text');
        if (!editable) return;
        this.selection = widget.id;
        this.updateToolbarState();
        const property = this.getEditableWidgetProperty(widget);
        const initialText = this.getEditableWidgetText(widget);
        this.inlineEditWidgetId = widget.id;
        editable.contentEditable = 'true';
        editable.focus();
        const selection = window.getSelection?.();
        const range = document.createRange?.();
        if (selection && range) {
            range.selectNodeContents(editable);
            range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }
        const onBlur = () => {
            void this.finishInlineTextEdit(true);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                void this.finishInlineTextEdit(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void this.finishInlineTextEdit(true);
            }
        };
        this.inlineEditState = {
            widgetId: widget.id,
            property,
            initialText,
            editable,
            onBlur,
            onKeyDown,
            finishing: false
        };
        editable.addEventListener('blur', onBlur);
        editable.addEventListener('keydown', onKeyDown);
    },

    async flushInlineTextEdit() {
        if (this.inlineEditWidgetId) {
            await this.finishInlineTextEdit(true);
        }
        if (this.inlineEditCommitPromise) {
            await this.inlineEditCommitPromise;
        }
    },

    async finishInlineTextEdit(commit = true) {
        const state = this.inlineEditState;
        if (!state || state.finishing) {
            return this.inlineEditCommitPromise || null;
        }
        state.finishing = true;
        const { editable, initialText, onBlur, onKeyDown, property, widgetId } = state;
        editable.removeEventListener('blur', onBlur);
        editable.removeEventListener('keydown', onKeyDown);
        editable.contentEditable = 'false';
        this.inlineEditState = null;
        this.inlineEditWidgetId = '';
        const nextText = editable.textContent || '';
        if (!commit) {
            editable.textContent = initialText;
            if (this.pendingRenderAfterInlineEdit) {
                this.renderWidgets();
            } else {
                this.updateToolbarState();
            }
            return null;
        }
        if (nextText === initialText) {
            if (this.pendingRenderAfterInlineEdit) {
                this.renderWidgets();
            } else {
                this.updateToolbarState();
            }
            return null;
        }
        this.inlineEditCommitPromise = this.runFinalChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef: widgetId,
            reason: 'edit',
            patch: {properties: {[property]: nextText}}
        }).finally(() => {
            this.inlineEditCommitPromise = null;
            if (this.pendingRenderAfterInlineEdit) {
                this.renderWidgets();
            }
        });
        return this.inlineEditCommitPromise;
    }
};
