import { TEXT_DEFAULT_STYLE } from './webmeet-blackboard-text-style.js';
export const blackboardRenderingMethods = {
    renderWidgets() {
        if (!this.board) return;
        if (this.inlineEditWidgetId) {
            this.pendingRenderAfterInlineEdit = true;
            this.updateToolbarState();
            return;
        }
        this.pendingRenderAfterInlineEdit = false;
        this.applyBoardBackground();
        const fragment = document.createDocumentFragment();
        this.widgetNodes.clear();
        const widgets = this.blackboard?.widgets || [];
        const {widgetOrdinals, groupOrdinals} = this.getRoboTargetOrdinals(widgets);
        if (this.fullscreenWidgetId && !widgets.some((widget) => String(widget.id || '') === String(this.fullscreenWidgetId))) {
            this.fullscreenWidgetId = '';
        }
        for (const widget of widgets) {
            const node = this.renderWidget(widget, Number(widgetOrdinals.get(String(widget.id || '')) || 0));
            fragment.append(node);
            this.widgetNodes.set(widget.id, node);
        }
        this.board.replaceChildren(fragment);
        this.renderGroupHitAreas(groupOrdinals);
        this.renderSelectionOverlay();
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
        const minPollWidth = widget.type === 'poll' ? 260 : 1;
        const minPollHeight = widget.type === 'poll' ? 132 : 1;
        const minBulletsWidth = widget.type === 'bullets' ? 320 : 1;
        const minBulletsHeight = widget.type === 'bullets' ? 190 : 1;
        const minScriptaWidth = widget.type === 'scripta-document' ? 600 : 1;
        const minScriptaHeight = widget.type === 'scripta-document' ? 400 : 1;
        node.style.width = `${Math.max(widgetWidth, minPollWidth, minBulletsWidth, minScriptaWidth)}px`;
        node.style.height = `${Math.max(widgetHeight, minPollHeight, minBulletsHeight, minScriptaHeight)}px`;
        const rotation = this.getWidgetRotation(widget);
        node.style.transform = rotation ? `rotate(${rotation}deg)` : '';
        node.style.transformOrigin = 'center center';
        node.style.setProperty('--widget-rotation', `${rotation}deg`);
        node.style.setProperty('--widget-counter-rotation', `${-rotation}deg`);
        const themeDefaults = this.getBlackboardTheme().defaults || {};
        const typeDefaults = themeDefaults[widget.type] || themeDefaults.shape || {};
        const textDefaults = themeDefaults.text || {};
        node.style.setProperty('--fill', style.fill || typeDefaults.fill || 'var(--bb-widget-bg)');
        node.style.setProperty('--stroke', style.stroke || typeDefaults.stroke || 'var(--bb-widget-border)');
        const cssStrokeWidth = Number(style.strokeWidth ?? typeDefaults.strokeWidth ?? 1) || 0;
        node.style.setProperty('--stroke-width', `${cssStrokeWidth}px`);
        node.style.setProperty('--text-color', style.textColor || textDefaults.textColor || 'var(--bb-widget-text)');
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
        if (!isFullscreen && this.canMoveWidget(widget)) {
            node.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        }
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

    projectAttachedConnection(widget) {
        const connection = widget?.properties?.connection;
        if (widget?.type !== 'line' || !connection) return widget;
        const widgets = this.blackboard?.widgets || [];
        const anchorPoint = (endpoint) => {
            const target = widgets.find((entry) => String(entry.id) === String(endpoint?.widgetId));
            if (!target) return null;
            const geometry = target.properties?.geometry || {};
            const x = Number(geometry.x || 0);
            const y = Number(geometry.y || 0);
            const width = Number(geometry.width || 0);
            const height = Number(geometry.height || 0);
            const points = {
                left: { x, y: y + height / 2 },
                right: { x: x + width, y: y + height / 2 },
                top: { x: x + width / 2, y },
                bottom: { x: x + width / 2, y: y + height },
                center: { x: x + width / 2, y: y + height / 2 },
            };
            return points[String(endpoint.anchor || 'center')] || points.center;
        };
        const from = anchorPoint(connection.from);
        const to = anchorPoint(connection.to);
        if (!from || !to) return widget;
        const padding = 0.5;
        const x = Math.min(from.x, to.x) - padding;
        const y = Math.min(from.y, to.y) - padding;
        const width = Math.max(1, Math.abs(to.x - from.x) + padding * 2);
        const height = Math.max(1, Math.abs(to.y - from.y) + padding * 2);
        return {
            ...widget,
            properties: {
                ...widget.properties,
                geometry: { x, y, width, height, rotation: 0 },
                line: { ...(widget.properties.line || {}), x1: from.x - x, y1: from.y - y, x2: to.x - x, y2: to.y - y },
            },
        };
    },

    renderContextMenu(node, widget) {
        if (!widget?.id || widget.locked) return;
        if (!this.canEditWidget(widget) && !this.canMoveWidget(widget)) return;
        const menu = document.createElement('div');
        menu.className = 'webmeet-blackboard-context-menu';
        menu.setAttribute('aria-label', 'Widget actions');
        menu.addEventListener('pointerdown', (event) => event.stopPropagation());

        const moveHandle = this.createContextButton('move', 'Move widget', 'Move', 'move');
        moveHandle.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        menu.append(moveHandle);

        if (widget.type === 'scripta-document' && widget.properties?.resourceId) {
            const deleteButton = this.createContextButton('delete', 'Delete document file', 'Delete document file', 'delete');
            deleteButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (!globalThis.confirm?.(`Delete ${widget.properties.documentTitle || 'this document'} from the workspace?`)) return;
                void this.runScriptaEvent('scripta-document-delete', { resourceId: widget.properties.resourceId, confirmed: true });
            });
            menu.append(deleteButton);
        }

        if (this.canEditWidget(widget)) {
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

        if (this.canEditWidget(widget)) {
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
        return ['shape', 'line', 'card', 'text', 'image', 'poll', 'bullets', 'scripta-document'].includes(widgetType);
    },

    getWidgetMinimumSize(widget) {
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

    canMoveWidget(widget) {
        if (!widget || widget.locked) return false;
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
        if (widget.type === 'image') {
            const frame = document.createElement('div');
            frame.className = 'webmeet-blackboard-image-frame';
            const image = document.createElement('img');
            const source = widget.properties?.source || {};
            image.className = 'webmeet-blackboard-image';
            image.alt = String(widget.properties?.alt || source.name || 'Image');
            image.draggable = false;
            image.src = String(source.url || source.downloadUrl || widget.properties?.src || '');
            frame.append(image);
            node.append(frame);
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
            this.applyTextStyleToNode(text, widget.properties?.style || {});
            node.append(text);
            return;
        }
        node.textContent = this.getWidgetLabel(widget);
    },

    applyTextStyleToNode(node, style = {}) {
        const normalized = this.normalizeTextStyle(style, false);
        const theme = this.getBlackboardTheme();
        const textDefaults = theme.defaults?.text || {};
        node.style.fontFamily = String(normalized.fontFamily || TEXT_DEFAULT_STYLE.fontFamily);
        node.style.fontSize = `${Number(normalized.fontSize || TEXT_DEFAULT_STYLE.fontSize)}px`;
        node.style.fontWeight = String(normalized.fontWeight || TEXT_DEFAULT_STYLE.fontWeight);
        node.style.fontStyle = String(normalized.fontStyle || TEXT_DEFAULT_STYLE.fontStyle);
        node.style.color = String(normalized.textColor || textDefaults.textColor || theme.tokens?.widgetText || TEXT_DEFAULT_STYLE.textColor);
    },


    getWidgetLabel(widget) {
        if (widget.type === 'text') return widget.properties?.text || '';
        if (widget.type === 'poll') return widget.properties?.description || widget.type;
        if (widget.type === 'bullets') return widget.properties?.title || widget.type;
        return widget.properties?.label || '';
    }
};
