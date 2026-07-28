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

    async startPollWidget(widget) {
        if (!widget?.id || this.busy) return;
        await this.runFinalChange({
            changeType: 'start',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'pollStart'
        });
    },

    async closePollWidget(widget) {
        if (!widget?.id || this.busy) return;
        await this.runFinalChange({
            changeType: 'close',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'pollClose'
        });
    },

    async openPollModal(widget) {
        if (!widget?.id || !globalThis.assistOS?.UI?.showModal) return;
        const result = await globalThis.assistOS.UI.showModal('webmeet-blackboard-poll-modal', {
            'widget-json': encodeURIComponent(JSON.stringify(widget)),
            'participant-id': encodeURIComponent(String(this.adapter?.participantId || '')),
            'participant-name': encodeURIComponent(String(this.adapter?.participantName || this.adapter?.participantId || ''))
        }, true);
        if (!result?.answers) return;
        await this.submitInteractiveWidget(widget, {
            answers: result.answers,
            participantName: result.participantName
        });
    },

    async openPollResultsModal(widget) {
        if (!widget?.id || !globalThis.assistOS?.UI?.showModal) return;
        await globalThis.assistOS.UI.showModal('webmeet-blackboard-poll-results-modal', {
            'widget-json': encodeURIComponent(JSON.stringify(widget))
        }, true);
    },

    updateToolbarState() {
        this.toolbar?.setState?.({
            busy: this.busy,
            themeId: this.getBlackboardTheme().id,
            pendingWidgetType: this.pendingWidgetType
        });
    },

    setPendingWidgetType(type = '') {
        this.pendingWidgetType = String(type || '').trim();
        this.updateToolbarState();
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

    async addWidget(type, position = null) {
        await this.flushInlineTextEdit();
        const widget = this.createWidget(type, position);
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
                kind: 'explorer-media',
                assetId: image.id,
                url: image.url,
                mimeType: image.mimeType,
                name: image.name
            },
            alt: image.name,
            naturalSize: {
                width: image.width,
                height: image.height
            }
        };
        const naturalWidth = Math.max(1, Number(image.width || 240));
        const naturalHeight = Math.max(1, Number(image.height || 180));
        const naturalMax = Math.max(naturalWidth, naturalHeight);
        const scale = naturalMax > 360 ? 360 / naturalMax : naturalMax < 180 ? 180 / naturalMax : 1;
        const width = Math.max(1, Math.round(naturalWidth * scale));
        widget.properties.geometry = {
            ...(widget.properties.geometry || {}),
            width,
            height: Math.max(1, Math.round(naturalHeight * scale))
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
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
            throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
        }
        if (Number(file?.size || 0) > 15 * 1024 * 1024) throw new Error('Images may not exceed 15 MB.');
        const name = String(file?.name || 'Image').trim() || 'Image';
        const [upload, dimensions] = await Promise.all([
            this.uploadBlackboardImageBlob(file, name, mimeType),
            this.readImageDimensions(file)
        ]);
        return {
            id: upload.id,
            url: upload.url,
            mimeType: upload.mimeType || mimeType,
            name: upload.name || name,
            size: upload.size,
            width: dimensions.width,
            height: dimensions.height
        };
    },

    async uploadBlackboardImageBlob(file, name, mimeType) {
        const response = await fetch('/blobs/explorer', {
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
        const asset = await this.adapter?.commitMediaBlob?.(payload, name);
        const url = asset?.workspaceUrl
            ? `/workspace-files/${String(asset.workspaceUrl).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/')}`
            : '';
        if (!url) {
            throw new Error('Image upload did not return a usable URL.');
        }
        return {
            id: asset?.assetId || '',
            url,
            mimeType: asset?.mimeType || mimeType,
            name: asset?.filename || name,
            size: Number.isFinite(Number(asset?.size)) ? Number(asset.size) : Number(file?.size || 0)
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

    createWidget(type, position = null) {
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
        } else if (normalizedType === 'text') {
            widget.properties.style = {
                fill: 'transparent',
                fontFamily: TEXT_DEFAULT_STYLE.fontFamily,
                fontSize: TEXT_DEFAULT_STYLE.fontSize,
                fontWeight: TEXT_DEFAULT_STYLE.fontWeight,
                fontStyle: TEXT_DEFAULT_STYLE.fontStyle
            };
            widget.properties.text = 'Text';
        } else if (normalizedType === 'poll') {
            widget.properties.geometry = {x: 72 + offset, y: 64 + offset, width: 260, height: 132};
            widget.properties = {
                ...widget.properties,
                description: 'Poll',
                questions: [{
                    id: 'q1',
                    prompt: 'Question',
                    pollMode: 'choice',
                    options: ['Yes', 'No'],
                    ratingMax: 10
                }],
                allowPollChange: false,
                anonymous: false,
                status: 'open',
                durationSeconds: 0,
                startedAt: '',
                closesAt: '',
                participantData: {},
                aggregation: {
                    questions: {
                        q1: {counts: {Yes: 0, No: 0}, total: 0}
                    },
                    totalParticipants: 0
                },
                resultsVisibility: 'public'
            };
        } else if (normalizedType === 'bullets') {
            widget.properties.geometry = {x: 72 + offset, y: 64 + offset, width: 360, height: 230};
            widget.properties = {
                ...widget.properties,
                title: 'Meeting Bullets',
                meetingDateTime: new Date().toISOString(),
                items: [{
                    id: 'b1',
                    text: 'Add a note from the meeting',
                    status: 'todo',
                    priority: 'medium'
                }]
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
                widget.properties.label = '';
            }
        }
        this.applyWidgetPlacement(widget, position);
        return widget;
    },

    applyWidgetPlacement(widget, placement = null) {
        if (placement?.kind === 'draw') {
            this.positionWidgetFromDrawPlacement(widget, placement);
            return;
        }
        this.positionWidgetAtBoardPoint(widget, placement);
    },

    positionWidgetAtBoardPoint(widget, position = null) {
        if (!widget?.properties?.geometry || !position) return;
        const geometry = widget.properties.geometry;
        const width = Math.max(1, Number(geometry.width || 1) || 1);
        const height = Math.max(1, Number(geometry.height || 1) || 1);
        const x = Number(position.x);
        const y = Number(position.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return;
        widget.properties.geometry = {
            ...geometry,
            x: Math.max(0, Math.round(x - width / 2)),
            y: Math.max(0, Math.round(y - height / 2))
        };
    },

    positionWidgetFromDrawPlacement(widget, placement = null) {
        if (!widget?.properties?.geometry || !placement) return;
        if (widget.type === 'line') {
            this.positionLineWidgetFromDrawPlacement(widget, placement);
            return;
        }
        if (widget.type !== 'shape') return;
        const geometry = widget.properties.geometry;
        const x = Number(placement.x);
        const y = Number(placement.y);
        const width = Math.max(16, Number(placement.width || 0) || 0);
        const height = Math.max(16, Number(placement.height || 0) || 0);
        if (![x, y, width, height].every(Number.isFinite)) return;
        widget.properties.geometry = {
            ...geometry,
            x: Math.round(Math.max(0, x)),
            y: Math.round(Math.max(0, y)),
            width: Math.round(width),
            height: Math.round(height)
        };
    },

    positionLineWidgetFromDrawPlacement(widget, placement = null) {
        const x1 = Number(placement?.x1);
        const y1 = Number(placement?.y1);
        const x2 = Number(placement?.x2);
        const y2 = Number(placement?.y2);
        if (![x1, y1, x2, y2].every(Number.isFinite)) return;
        const minSize = 12;
        let x = Math.min(x1, x2);
        let y = Math.min(y1, y2);
        let width = Math.abs(x2 - x1);
        let height = Math.abs(y2 - y1);
        if (width < minSize) {
            x -= (minSize - width) / 2;
            width = minSize;
        }
        if (height < minSize) {
            y -= (minSize - height) / 2;
            height = minSize;
        }
        const line = {
            x1: x1 - x,
            y1: y1 - y,
            x2: x2 - x,
            y2: y2 - y,
            angle: this.normalizeLineAngle(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI)
        };
        widget.properties.geometry = {
            ...(widget.properties.geometry || {}),
            x: Math.round(Math.max(0, x)),
            y: Math.round(Math.max(0, y)),
            width: Math.round(width),
            height: Math.round(height)
        };
        widget.properties.line = {
            ...(widget.properties.line || {}),
            ...line
        };
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
        const widget = this.getWidgetById(targetRef);
        if (widget && this.canEditWidget && !this.canEditWidget(widget)) return;
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
        return !widget?.locked && ['shape', 'line', 'text', 'image'].includes(String(widget?.type || '').trim());
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
        if (this.canEditWidget && !this.canEditWidget(widget)) return;
        if (!globalThis.assistOS?.UI?.showModal) return;
        const result = await globalThis.assistOS.UI.showModal('webmeet-blackboard-widget-editor', {
            'widget-json': encodeURIComponent(JSON.stringify(widget)),
            'theme-json': encodeURIComponent(JSON.stringify(this.getBlackboardTheme()))
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

    async addBulletsNote(widget) {
        const props = widget?.properties || {};
        const items = Array.isArray(props.items) ? props.items : [];
        await this.editWidget({
            ...widget,
            properties: {
                ...props,
                items: [
                    ...items,
                    {
                        id: this.createNextBulletsItemId(items),
                        text: '',
                        status: 'todo',
                        priority: 'medium'
                    }
                ]
            }
        });
    },

    createNextBulletsItemId(items = []) {
        const used = new Set((Array.isArray(items) ? items : [])
            .map((item) => String(item?.id || '').trim())
            .filter(Boolean));
        let index = 1;
        while (used.has(`b${index}`)) {
            index += 1;
        }
        return `b${index}`;
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
        const onInput = () => {
            this.growInlineTextBoxToFit(widget.id, editable);
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
            onInput,
            onKeyDown,
            finishing: false
        };
        editable.addEventListener('blur', onBlur);
        editable.addEventListener('input', onInput);
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
        const { editable, initialText, onBlur, onInput, onKeyDown, property, widgetId } = state;
        editable.removeEventListener('blur', onBlur);
        editable.removeEventListener('input', onInput);
        editable.removeEventListener('keydown', onKeyDown);
        editable.contentEditable = 'false';
        this.inlineEditState = null;
        this.inlineEditWidgetId = '';
        const nextText = this.readInlineEditableText(editable);
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
        const fitGeometry = this.getInlineTextFitGeometry(widgetId, editable);
        this.inlineEditCommitPromise = (async () => {
            await this.runFinalChange({
                changeType: 'update',
                targetType: 'widget',
                targetRef: widgetId,
                reason: 'edit',
                patch: {properties: {[property]: nextText}}
            });
            if (fitGeometry) {
                await this.runFinalChange({
                    changeType: 'update',
                    targetType: 'widget',
                    targetRef: widgetId,
                    reason: 'resize',
                    patch: {properties: {geometry: fitGeometry}}
                });
            }
        })().finally(() => {
            this.inlineEditCommitPromise = null;
            if (this.pendingRenderAfterInlineEdit) {
                this.renderWidgets();
            }
        });
        return this.inlineEditCommitPromise;
    },

    readInlineEditableText(editable) {
        return String(editable?.innerText ?? editable?.textContent ?? '');
    },

    growInlineTextBoxToFit(widgetId, editable) {
        const fitGeometry = this.getInlineTextFitGeometry(widgetId, editable);
        if (!fitGeometry) return;
        const node = this.widgetNodes.get(widgetId);
        if (!node) return;
        node.style.width = `${fitGeometry.width}px`;
        node.style.height = `${fitGeometry.height}px`;
    },

    getInlineTextFitGeometry(widgetId, editable) {
        const widget = (this.blackboard?.widgets || []).find((entry) => String(entry?.id || '') === String(widgetId || ''));
        if (widget?.type !== 'text' || !editable) return null;
        const node = this.widgetNodes.get(widgetId);
        const geometry = widget.properties?.geometry || {};
        const currentWidth = Math.max(1, Number(geometry.width || node?.offsetWidth || 120) || 120);
        const currentHeight = Math.max(1, Number(geometry.height || node?.offsetHeight || 64) || 64);
        const nextWidth = Math.ceil(Math.max(currentWidth, Number(editable.scrollWidth || 0) + 16));
        const nextHeight = Math.ceil(Math.max(currentHeight, Number(editable.scrollHeight || 0) + 16));
        if (nextWidth <= currentWidth && nextHeight <= currentHeight) return null;
        return {
            ...geometry,
            width: nextWidth,
            height: nextHeight
        };
    }
};
