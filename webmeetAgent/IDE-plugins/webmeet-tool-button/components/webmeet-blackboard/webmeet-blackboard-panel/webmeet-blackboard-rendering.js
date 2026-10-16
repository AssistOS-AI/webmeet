import { TEXT_DEFAULT_STYLE } from './webmeet-blackboard-text-style.js';

export const blackboardRenderingMethods = {
    renderWidgets() {
        if (!this.board) return;
        this.applyBoardBackground();
        const widgets = this.blackboard?.widgets || [];
        const {widgetOrdinals, groupOrdinals} = this.getRoboTargetOrdinals(widgets);
        const protectedWidgetIds = this.getInteractionProtectedWidgetIds();
        const hasGroupInteraction = Boolean(this.groupDragState || this.groupResizeState || this.groupRotateState);
        const desiredWidgetIds = new Set(widgets.map((widget) => String(widget?.id || '')).filter(Boolean));
        let deferredInlineRender = false;
        let deferredInteractionRender = false;

        this.clearTransientBoardDecorations({preserveGroupInteraction: hasGroupInteraction});
        if (this.fullscreenWidgetId && !widgets.some((widget) => String(widget.id || '') === String(this.fullscreenWidgetId))) {
            this.fullscreenWidgetId = '';
        }
        for (const [widgetId, node] of this.widgetNodes) {
            if (desiredWidgetIds.has(String(widgetId))) continue;
            node?.remove?.();
            this.widgetNodes.delete(widgetId);
            this.widgetRenderKeys.delete(widgetId);
        }
        for (const widget of widgets) {
            const widgetId = String(widget?.id || '');
            if (!widgetId) continue;
            const ordinal = Number(widgetOrdinals.get(widgetId) || 0);
            const renderKey = this.createWidgetRenderKey(widget, ordinal);
            const existingNode = this.widgetNodes.get(widgetId);
            if (existingNode && this.widgetRenderKeys.get(widgetId) === renderKey) continue;
            if (existingNode && protectedWidgetIds.has(widgetId)) {
                if (widgetId === String(this.inlineEditWidgetId || '')) deferredInlineRender = true;
                else deferredInteractionRender = true;
                continue;
            }
            const node = this.renderWidget(widget, ordinal);
            if (existingNode?.replaceWith) existingNode.replaceWith(node);
            else this.board.append(node);
            this.widgetNodes.set(widgetId, node);
            this.widgetRenderKeys.set(widgetId, renderKey);
        }
        this.orderWidgetNodes(widgets);
        this.pendingRenderAfterInlineEdit = deferredInlineRender;
        this.pendingRenderAfterInteraction = deferredInteractionRender;
        if (!hasGroupInteraction) {
            this.renderGroupHitAreas(groupOrdinals);
            this.renderSelectionOverlay();
        }
        if (String(this.pendingWidgetType || '').startsWith('line') || this.resizeState?.lineResize) {
            this.renderConnectionAnchors();
        }
        this.updateToolbarState();
    },

    renderWidget(widget, ordinal = 0) {
        widget = this.projectAttachedConnection(widget);
        const node = document.createElement('div');
        const geometry = widget.properties?.geometry || {};
        const style = widget.properties?.style || {};
        node.className = `webmeet-blackboard-widget ${widget.type || 'shape'}`;
        node.classList.toggle('is-locked', Boolean(widget.locked));
        const isFullscreen = String(this.fullscreenWidgetId || '') === String(widget.id || '');
        node.classList.toggle('is-fullscreen', isFullscreen);
        node.dataset.widgetId = widget.id;
        node.tabIndex = 0;
        const multiSelected = this.decorateWidgetGroupSelection(node, widget);
        node.setAttribute('aria-selected', String(!widget.groupId && this.selection === widget.id && !multiSelected));
        node.style.left = `${Number(geometry.x || 0)}px`;
        node.style.top = `${Number(geometry.y || 0)}px`;
        const widgetWidth = Number(geometry.width || 120);
        const widgetHeight = Number(geometry.height || 64);
        const minFileWidth = widget.type === 'file' ? 160 : 1;
        const minFileHeight = widget.type === 'file' ? 100 : 1;
        const minPollWidth = widget.type === 'poll' ? 260 : 1;
        const minPollHeight = widget.type === 'poll' ? 132 : 1;
        const minBulletsWidth = widget.type === 'bullets' ? 320 : 1;
        const minBulletsHeight = widget.type === 'bullets' ? 190 : 1;
        const minScriptaWidth = widget.type === 'scripta-document' ? 600 : 1;
        const minScriptaHeight = widget.type === 'scripta-document' ? 400 : 1;
        node.style.width = `${Math.max(widgetWidth, minFileWidth, minPollWidth, minBulletsWidth, minScriptaWidth)}px`;
        node.style.height = `${Math.max(widgetHeight, minFileHeight, minPollHeight, minBulletsHeight, minScriptaHeight)}px`;
        const rotation = this.getWidgetRotation(widget);
        node.style.transform = rotation ? `rotate(${rotation}deg)` : '';
        node.style.transformOrigin = 'center center';
        node.style.setProperty('--widget-rotation', `${rotation}deg`);
        node.style.setProperty('--widget-counter-rotation', `${-rotation}deg`);
        const theme = this.getBlackboardTheme();
        const themeDefaults = theme.defaults || {};
        const themeTokens = theme.tokens || {};
        const typeDefaults = themeDefaults[widget.type] || themeDefaults.shape || {};
        const textDefaults = themeDefaults.text || {};
        const defaultTextColor = widget.type === 'text'
            ? textDefaults.textColor
            : (typeDefaults.textColor || themeTokens.widgetText);
        node.style.setProperty('--fill', style.fill || typeDefaults.fill || 'var(--bb-widget-bg)');
        node.style.setProperty('--stroke', style.stroke || typeDefaults.stroke || 'var(--bb-widget-border)');
        const cssStrokeWidth = Number(style.strokeWidth ?? typeDefaults.strokeWidth ?? 1) || 0;
        node.style.setProperty('--stroke-width', `${cssStrokeWidth}px`);
        node.style.setProperty('--text-color', style.textColor || defaultTextColor || 'var(--bb-widget-text)');
        this.renderWidgetContent(node, widget);
        if (this.roboOrdinalMode && ordinal > 0) {
            const badge = document.createElement('span');
            badge.className = 'webmeet-blackboard-widget-ordinal';
            badge.textContent = String(ordinal);
            badge.setAttribute('aria-hidden', 'true');
            node.append(badge);
        }
        if (!isFullscreen && !widget.groupId) this.renderResizeHandles(node, widget);
        if (!isFullscreen && !widget.groupId && !multiSelected) this.renderContextMenu(node, widget);
        node.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (widget.groupId) return;
            if (!this.canEditWidget(widget)) return;
            this.selection = widget.id;
            void this.editWidget(widget);
        });
        return node;
    },

    renderContextMenu(node, widget) {
        if (!widget?.id || widget.locked) return;
        if (!this.canEditWidget(widget) && !this.canMoveWidget(widget)) return;
        const menu = document.createElement('div');
        menu.className = 'webmeet-blackboard-context-menu';
        menu.setAttribute('aria-label', 'Widget actions');
        menu.addEventListener('pointerdown', (event) => event.stopPropagation());

        const moveHandle = this.createContextButton('move', 'Move widget', 'Move', 'move');
        menu.append(moveHandle);

        this.appendFileContextDownload(menu, widget);

        this.appendImageScriptaButton(menu, widget);
        if (widget.type !== 'file' && this.canEditWidget(widget)) {
            const settingsButton = this.createContextButton('settings', 'Widget settings', 'Widget settings', 'settings');
            settingsButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.selection = widget.id;
                void this.editWidget(widget);
            });
            menu.append(settingsButton);
        }

        if (this.canRotateWidget(widget)) {
            const rotateHandle = this.createContextButton('rotate', 'Rotate widget', 'Rotate', 'rotate');
            rotateHandle.addEventListener('pointerdown', (event) => this.beginLocalRotate(event, widget));
            menu.append(rotateHandle);
        }

        if (this.canDeleteWidget(widget)) {
            const deleteButton = this.createContextButton('delete', 'Delete widget', 'Delete', 'delete');
            deleteButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.selection = widget.id;
                void this.deleteSelectedWidget();
            });
            menu.append(deleteButton);
        }
        node.append(menu);
    },

    createContextButton(action, title, ariaLabel, icon) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `webmeet-blackboard-context-button ${action}`;
        button.dataset.contextAction = action;
        button.title = title;
        button.setAttribute('aria-label', ariaLabel);
        button.append(this.createContextIcon(icon));
        return button;
    },

    createContextIcon(icon) {
        const span = document.createElement('span');
        span.className = `webmeet-blackboard-context-icon ${icon}`;
        span.setAttribute('aria-hidden', 'true');
        return span;
    },

    toggleBulletsFullscreen(widgetId = '') {
        const normalizedId = String(widgetId || '').trim();
        if (!normalizedId) return;
        this.fullscreenWidgetId = this.fullscreenWidgetId === normalizedId ? '' : normalizedId;
        this.selection = normalizedId;
        this.renderWidgets();
    },

    canResizeWidget(widget) {
        if (!widget || widget.locked) return false;
        if (widget.type === 'poll' && !this.canEditWidget(widget)) return false;
        const widgetType = String(widget.type || 'shape').trim() || 'shape';
        return ['shape', 'line', 'card', 'text', 'image', 'file', 'poll', 'bullets', 'scripta-document'].includes(widgetType);
    },

    getWidgetMinimumSize(widget) {
        if (widget?.type === 'file') return {minWidth: 160, minHeight: 100};
        if (widget?.type === 'poll') return {minWidth: 260, minHeight: 132};
        if (widget?.type === 'bullets') return {minWidth: 320, minHeight: 190};
        if (widget?.type === 'scripta-document') return {minWidth: 600, minHeight: 400};
        return {minWidth: 48, minHeight: 32};
    },

    canEditWidget(widget) {
        if (!widget) return false;
        if (String(widget.type || '').startsWith('scripta-')) return false;
        if (widget.type !== 'poll') return true;
        return widget.properties?.canManagePoll === true;
    },

    canDeleteWidget(widget) {
        return Boolean(widget && !widget.locked && (
            widget.type === 'scripta-document' || this.canEditWidget(widget)
        ));
    },

    canMoveWidget(widget) {
        if (!widget || widget.locked) return false;
        if (widget.type === 'line' && widget.properties?.connection) return false;
        if (widget.type === 'poll') return this.canEditWidget(widget);
        return true;
    },

    renderResizeHandles(node, widget) {
        if (!this.canResizeWidget(widget)) return;
        if (widget.type === 'line') {
            const geometry = widget.properties?.geometry || {};
            const line = widget.properties?.line || {};
            const width = Math.max(1, Number(geometry.width || 220) || 220);
            const height = Math.max(1, Number(geometry.height || 80) || 80);
            const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
            const handles = [
                {name: 'line-start', x: Number(line.x1 ?? endpoints.x1), y: Number(line.y1 ?? endpoints.y1)},
                {name: 'line-end', x: Number(line.x2 ?? endpoints.x2), y: Number(line.y2 ?? endpoints.y2)}
            ];
            for (const handle of handles) {
                const resizeHandle = document.createElement('span');
                resizeHandle.className = `webmeet-blackboard-resize-handle line-endpoint ${handle.name}`;
                resizeHandle.dataset.resizeHandle = handle.name;
                resizeHandle.setAttribute('aria-hidden', 'true');
                resizeHandle.style.left = `${handle.x}px`;
                resizeHandle.style.top = `${handle.y}px`;
                resizeHandle.addEventListener('pointerdown', (event) => this.beginLocalResize(event, widget, handle.name));
                node.append(resizeHandle);
            }
            return;
        }
        for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const resizeHandle = document.createElement('span');
            resizeHandle.className = `webmeet-blackboard-resize-handle ${handle}`;
            resizeHandle.dataset.resizeHandle = handle;
            resizeHandle.setAttribute('aria-hidden', 'true');
            resizeHandle.addEventListener('pointerdown', (event) => this.beginLocalResize(event, widget, handle));
            node.append(resizeHandle);
        }
    },

    renderWidgetContent(node, widget) {
        node.replaceChildren();
        if (widget.type === 'shape') {
            node.append(this.createShapeSvg(widget));
            return;
        }
        if (widget.type === 'line') {
            node.append(this.createLineSvg(widget));
            return;
        }
        if (widget.type === 'image' || widget.type === 'file') {
            this.renderAttachmentWidgetContent(node, widget);
            return;
        }
        if (widget.type === 'poll') {
            this.renderPollWidgetContent(node, widget);
            return;
        }
        if (widget.type === 'bullets') {
            this.renderBulletsWidgetContent(node, widget);
            return;
        }
        if (widget.type === 'scripta-document') {
            this.renderScriptaDocument(node, widget);
            return;
        }
        if (widget.type === 'text' || widget.type === 'card') {
            if (widget.type === 'card' && String(widget.properties?.title || '').trim()) {
                const title = document.createElement('div');
                title.className = 'webmeet-blackboard-widget-title';
                title.textContent = String(widget.properties.title || '');
                node.append(title);
            }
            const text = document.createElement('div');
            text.className = 'webmeet-blackboard-inline-text';
            text.tabIndex = 0;
            text.setAttribute('role', 'textbox');
            text.setAttribute('aria-label', 'Edit widget text');
            text.textContent = this.getEditableWidgetText(widget);
            text.addEventListener('focusin', () => this.startInlineTextEdit(widget));
            text.addEventListener('pointerdown', (event) => {
                if (text.isContentEditable) event.stopPropagation();
            });
            this.applyTextStyleToNode(text, widget);
            node.append(text);
            return;
        }
        node.textContent = this.getWidgetLabel(widget);
    },

    applyTextStyleToNode(node, widget = {}) {
        const style = widget.properties?.style || {};
        const normalized = this.normalizeTextStyle(style, false);
        const theme = this.getBlackboardTheme();
        const textDefaults = theme.defaults?.text || {};
        const typeDefaults = theme.defaults?.[widget.type] || theme.defaults?.shape || {};
        const defaultTextColor = widget.type === 'text'
            ? textDefaults.textColor
            : (typeDefaults.textColor || theme.tokens?.widgetText);
        node.style.fontFamily = String(normalized.fontFamily || TEXT_DEFAULT_STYLE.fontFamily);
        node.style.fontSize = `${Number(normalized.fontSize || TEXT_DEFAULT_STYLE.fontSize)}px`;
        node.style.fontWeight = String(normalized.fontWeight || TEXT_DEFAULT_STYLE.fontWeight);
        node.style.fontStyle = String(normalized.fontStyle || TEXT_DEFAULT_STYLE.fontStyle);
        node.style.color = String(normalized.textColor || defaultTextColor || TEXT_DEFAULT_STYLE.textColor);
    },

    getWidgetLabel(widget) {
        if (widget.type === 'text') return widget.properties?.text || '';
        if (widget.type === 'poll') return widget.properties?.description || widget.type;
        if (widget.type === 'bullets') return widget.properties?.title || widget.type;
        return widget.properties?.label || '';
    }
};
