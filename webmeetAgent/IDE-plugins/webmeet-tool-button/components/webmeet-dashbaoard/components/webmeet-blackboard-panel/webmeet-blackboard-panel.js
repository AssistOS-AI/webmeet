const blackboardActionMethods = {
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

    setActiveTool(tool) {
        this.activeTool = String(tool || 'select').trim() || 'select';
        this.updateToolbarState();
    },

    updateToolbarState() {
        this.toolbar?.setState?.({
            activeTool: this.activeTool,
            busy: this.busy,
            background: this.getBlackboardBackground()
        });
    },

    getBlackboardBackground() {
        const background = this.blackboard?.metadata?.background || {};
        const color = this.normalizeColor(background.color) || '#ffffff';
        const gridColor = this.normalizeColor(background.gridColor) || '#eef2f7';
        return {
            color,
            gridColor,
            gridSize: Number(background.gridSize || 24) || 24
        };
    },

    normalizeColor(value) {
        const color = String(value || '').trim();
        return /^#[0-9a-f]{6}$/i.test(color) ? color : '';
    },

    applyBoardBackground() {
        if (!this.board) return;
        const background = this.getBlackboardBackground();
        this.board.style.setProperty('--blackboard-background-color', background.color);
        this.board.style.setProperty('--blackboard-grid-color', background.gridColor);
        this.board.style.setProperty('--blackboard-grid-size', `${background.gridSize}px`);
    },

    async setBlackboardBackground(background = {}) {
        const color = this.normalizeColor(background.color);
        if (!color) return;
        await this.runFinalChange({
            changeType: 'update',
            targetType: 'blackboard',
            reason: 'background',
            patch: {
                metadata: {
                    background: {
                        ...this.getBlackboardBackground(),
                        color
                    }
                }
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
                style: {fill: '#ffffff', stroke: '#334155'}
            },
            visibility: {mode: 'all'},
            locked: false
        };
        if (normalizedType === 'line') {
            widget.properties.geometry = {x: 72 + offset, y: 96 + offset, width: 220, height: 80};
            widget.properties.style = {stroke: '#334155', strokeWidth: 3};
            const angle = 340;
            widget.properties.line = {
                angle,
                ...this.getLineEndpoints(220, 80, angle),
                markerStart: variant === 'arrow-both' ? 'arrow' : '',
                markerEnd: variant === 'arrow-end' || variant === 'arrow-both' ? 'arrow' : ''
            };
            widget.properties.label = '';
        } else if (normalizedType === 'text') {
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

    async undo() {
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
        if (widget.type === 'text' || widget.type === 'card') {
            this.startInlineTextEdit(widget);
            return;
        }
        this.editor?.open?.(widget);
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
        const finish = async (commit) => {
            editable.removeEventListener('blur', onBlur);
            editable.removeEventListener('keydown', onKeyDown);
            editable.contentEditable = 'false';
            this.inlineEditWidgetId = '';
            const nextText = editable.textContent || '';
            if (!commit) {
                editable.textContent = initialText;
                return;
            }
            if (nextText === initialText) return;
            await this.runFinalChange({
                changeType: 'update',
                targetType: 'widget',
                targetRef: widget.id,
                reason: 'edit',
                patch: {properties: {[property]: nextText}}
            });
        };
        const onBlur = () => {
            void finish(true);
        };
        const onKeyDown = (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                void finish(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void finish(true);
            }
        };
        editable.addEventListener('blur', onBlur);
        editable.addEventListener('keydown', onKeyDown);
    }
};

const blackboardGeometryMethods = {
    normalizeLineAngle(angle) {
        const value = Number(angle);
        if (!Number.isFinite(value)) return 0;
        return ((value % 360) + 360) % 360;
    },

    getLineAngle(line = {}) {
        if (line.angle !== undefined && line.angle !== null) {
            return this.normalizeLineAngle(line.angle);
        }
        const x1 = Number(line.x1 ?? 0);
        const y1 = Number(line.y1 ?? 0);
        const x2 = Number(line.x2 ?? 1);
        const y2 = Number(line.y2 ?? 0);
        return this.normalizeLineAngle(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
    },

    getLineEndpoints(width, height, angle) {
        const safeWidth = Math.max(1, Number(width) || 1);
        const safeHeight = Math.max(1, Number(height) || 1);
        const radians = this.normalizeLineAngle(angle) * Math.PI / 180;
        const dx = Math.cos(radians);
        const dy = Math.sin(radians);
        const cx = safeWidth / 2;
        const cy = safeHeight / 2;
        const tx = Math.abs(dx) > 0.0001 ? cx / Math.abs(dx) : Number.POSITIVE_INFINITY;
        const ty = Math.abs(dy) > 0.0001 ? cy / Math.abs(dy) : Number.POSITIVE_INFINITY;
        const length = Math.min(tx, ty);
        return {
            x1: cx - dx * length,
            y1: cy - dy * length,
            x2: cx + dx * length,
            y2: cy + dy * length
        };
    },

    getLineResizeState(widget, handle, event) {
        const geometry = widget.properties?.geometry || {};
        const line = widget.properties?.line || {};
        const width = Math.max(1, Number(geometry.width || 220) || 220);
        const height = Math.max(1, Number(geometry.height || 80) || 80);
        const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
        const start = {
            x: Number(line.x1 ?? endpoints.x1),
            y: Number(line.y1 ?? endpoints.y1)
        };
        const end = {
            x: Number(line.x2 ?? endpoints.x2),
            y: Number(line.y2 ?? endpoints.y2)
        };
        const originX = Number(geometry.x || 0);
        const originY = Number(geometry.y || 0);
        const moving = handle === 'line-start' ? start : end;
        const fixed = handle === 'line-start' ? end : start;
        return {
            fixedPoint: {
                x: originX + fixed.x,
                y: originY + fixed.y
            },
            movingPoint: {
                x: originX + moving.x,
                y: originY + moving.y
            },
            movingEndpoint: handle === 'line-start' ? 'start' : 'end',
            startX: event.clientX,
            startY: event.clientY
        };
    },

    getResizedGeometry(state, event) {
        const minWidth = 48;
        const minHeight = 32;
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        const affectsWest = state.handle.includes('w');
        const affectsEast = state.handle.includes('e');
        const affectsNorth = state.handle.includes('n');
        const affectsSouth = state.handle.includes('s');
        let x = state.originX;
        let y = state.originY;
        let width = state.originWidth;
        let height = state.originHeight;
        if (affectsEast) {
            width = Math.max(minWidth, state.originWidth + dx);
        }
        if (affectsSouth) {
            height = Math.max(minHeight, state.originHeight + dy);
        }
        if (affectsWest) {
            width = Math.max(minWidth, state.originWidth - dx);
            x = state.originX + state.originWidth - width;
        }
        if (affectsNorth) {
            height = Math.max(minHeight, state.originHeight - dy);
            y = state.originY + state.originHeight - height;
        }
        return {x, y, width, height};
    },

    getLineEndpointResize(state, event) {
        const lineState = state.lineResize;
        const dx = event.clientX - lineState.startX;
        const dy = event.clientY - lineState.startY;
        const fixedPoint = lineState.fixedPoint;
        const movingPoint = {
            x: lineState.movingPoint.x + dx,
            y: lineState.movingPoint.y + dy
        };
        const minSize = 12;
        const minX = Math.min(fixedPoint.x, movingPoint.x);
        const minY = Math.min(fixedPoint.y, movingPoint.y);
        const maxX = Math.max(fixedPoint.x, movingPoint.x);
        const maxY = Math.max(fixedPoint.y, movingPoint.y);
        let x = minX;
        let y = minY;
        let width = maxX - minX;
        let height = maxY - minY;
        if (width < minSize) {
            x -= (minSize - width) / 2;
            width = minSize;
        }
        if (height < minSize) {
            y -= (minSize - height) / 2;
            height = minSize;
        }
        const fixedLocal = {
            x: fixedPoint.x - x,
            y: fixedPoint.y - y
        };
        const movingLocal = {
            x: movingPoint.x - x,
            y: movingPoint.y - y
        };
        const line = lineState.movingEndpoint === 'start'
            ? {x1: movingLocal.x, y1: movingLocal.y, x2: fixedLocal.x, y2: fixedLocal.y}
            : {x1: fixedLocal.x, y1: fixedLocal.y, x2: movingLocal.x, y2: movingLocal.y};
        line.angle = this.normalizeLineAngle(Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180 / Math.PI);
        return {
            geometry: {x, y, width, height},
            line
        };
    },

    applyLineResizePreview(node, resize) {
        node.style.left = `${resize.geometry.x}px`;
        node.style.top = `${resize.geometry.y}px`;
        node.style.width = `${resize.geometry.width}px`;
        node.style.height = `${resize.geometry.height}px`;
        const svg = node.querySelector('.webmeet-blackboard-line-svg');
        const segment = svg?.querySelector?.('line');
        svg?.setAttribute('viewBox', `0 0 ${resize.geometry.width} ${resize.geometry.height}`);
        segment?.setAttribute('x1', String(resize.line.x1));
        segment?.setAttribute('y1', String(resize.line.y1));
        segment?.setAttribute('x2', String(resize.line.x2));
        segment?.setAttribute('y2', String(resize.line.y2));
        const startHandle = node.querySelector('[data-resize-handle="line-start"]');
        const endHandle = node.querySelector('[data-resize-handle="line-end"]');
        if (startHandle) {
            startHandle.style.left = `${resize.line.x1}px`;
            startHandle.style.top = `${resize.line.y1}px`;
        }
        if (endHandle) {
            endHandle.style.left = `${resize.line.x2}px`;
            endHandle.style.top = `${resize.line.y2}px`;
        }
    }
};

const blackboardInteractionMethods = {
    beginLocalDrag(event, widget) {
        if (widget.locked || this.activeTool !== 'select') return;
        if (event.target?.closest?.('.webmeet-blackboard-inline-text')) return;
        if (event.target?.closest?.('[data-resize-handle]')) return;
        event.preventDefault();
        this.selection = widget.id;
        this.updateToolbarState();
        const node = event.currentTarget;
        const geometry = widget.properties?.geometry || {};
        this.dragState = {
            widget,
            node,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: Number(geometry.x || 0),
            originY: Number(geometry.y || 0)
        };
        node.setPointerCapture?.(event.pointerId);
        node.addEventListener('pointermove', this.handleLocalDrag);
        node.addEventListener('pointerup', this.finishLocalDrag);
        node.addEventListener('pointercancel', this.cancelLocalDrag);
    },

    beginLocalResize(event, widget, handle) {
        if (!this.canResizeWidget(widget) || this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        this.selection = widget.id;
        this.updateToolbarState();
        const node = event.currentTarget.closest('.webmeet-blackboard-widget');
        if (!node) return;
        const geometry = widget.properties?.geometry || {};
        this.resizeState = {
            widget,
            node,
            handle,
            lineResize: widget.type === 'line' ? this.getLineResizeState(widget, handle, event) : null,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: Number(geometry.x || 0),
            originY: Number(geometry.y || 0),
            originWidth: Number(geometry.width || 120),
            originHeight: Number(geometry.height || 64)
        };
        node.setPointerCapture?.(event.pointerId);
        node.addEventListener('pointermove', this.handleLocalResize);
        node.addEventListener('pointerup', this.finishLocalResize);
        node.addEventListener('pointercancel', this.cancelLocalResize);
    },

    handleLocalDrag(event) {
        if (!this.dragState) return;
        const x = this.dragState.originX + event.clientX - this.dragState.startX;
        const y = this.dragState.originY + event.clientY - this.dragState.startY;
        this.dragState.node.style.left = `${x}px`;
        this.dragState.node.style.top = `${y}px`;
    },

    async finishLocalDrag() {
        if (!this.dragState) return;
        const {widget, node, originX, originY} = this.dragState;
        const x = Number.parseFloat(node.style.left) || originX;
        const y = Number.parseFloat(node.style.top) || originY;
        this.detachDragListeners(node);
        this.dragState = null;
        const response = await this.adapter?.sendChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'drag',
            patch: {
                properties: {
                    geometry: {
                        ...(widget.properties?.geometry || {}),
                        x,
                        y
                    }
                }
            }
        });
        if (response?.blackboard) {
            this.blackboard = response.blackboard;
            this.renderWidgets();
        }
    },

    cancelLocalDrag() {
        if (!this.dragState) return;
        const {node, originX, originY} = this.dragState;
        node.style.left = `${originX}px`;
        node.style.top = `${originY}px`;
        this.detachDragListeners(node);
        this.dragState = null;
    },

    detachDragListeners(node) {
        node.removeEventListener('pointermove', this.handleLocalDrag);
        node.removeEventListener('pointerup', this.finishLocalDrag);
        node.removeEventListener('pointercancel', this.cancelLocalDrag);
    },

    handleLocalResize(event) {
        if (!this.resizeState) return;
        if (this.resizeState.lineResize) {
            this.applyLineResizePreview(this.resizeState.node, this.getLineEndpointResize(this.resizeState, event));
            return;
        }
        const geometry = this.getResizedGeometry(this.resizeState, event);
        this.resizeState.node.style.left = `${geometry.x}px`;
        this.resizeState.node.style.top = `${geometry.y}px`;
        this.resizeState.node.style.width = `${geometry.width}px`;
        this.resizeState.node.style.height = `${geometry.height}px`;
    },

    async finishLocalResize(event) {
        if (!this.resizeState) return;
        const {widget, node} = this.resizeState;
        const lineResize = this.resizeState.lineResize
            ? this.getLineEndpointResize(this.resizeState, event)
            : null;
        const geometry = lineResize?.geometry || this.getResizedGeometry(this.resizeState, event);
        const nextProperties = {
            geometry: {
                ...(widget.properties?.geometry || {}),
                ...geometry
            }
        };
        if (widget.type === 'line') {
            const currentLine = widget.properties?.line || {};
            nextProperties.line = {
                ...currentLine,
                ...(lineResize?.line || {})
            };
        }
        this.detachResizeListeners(node);
        this.resizeState = null;
        const response = await this.adapter?.sendChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef: widget.id,
            reason: 'resize',
            patch: {
                properties: nextProperties
            }
        });
        if (response?.blackboard) {
            this.blackboard = response.blackboard;
            this.renderWidgets();
        }
    },

    cancelLocalResize() {
        if (!this.resizeState) return;
        const {node, originX, originY, originWidth, originHeight} = this.resizeState;
        node.style.left = `${originX}px`;
        node.style.top = `${originY}px`;
        node.style.width = `${originWidth}px`;
        node.style.height = `${originHeight}px`;
        this.detachResizeListeners(node);
        this.resizeState = null;
    },

    detachResizeListeners(node) {
        node.removeEventListener('pointermove', this.handleLocalResize);
        node.removeEventListener('pointerup', this.finishLocalResize);
        node.removeEventListener('pointercancel', this.cancelLocalResize);
    }
};

const blackboardRenderingMethods = {
    renderWidgets() {
        if (!this.board) return;
        this.applyBoardBackground();
        const fragment = document.createDocumentFragment();
        this.widgetNodes.clear();
        for (const widget of this.blackboard?.widgets || []) {
            const node = this.renderWidget(widget);
            fragment.append(node);
            this.widgetNodes.set(widget.id, node);
        }
        this.board.replaceChildren(fragment);
        this.updateToolbarState();
    },

    renderWidget(widget) {
        const node = document.createElement('div');
        const geometry = widget.properties?.geometry || {};
        const style = widget.properties?.style || {};
        node.className = `webmeet-blackboard-widget ${widget.type || 'shape'}`;
        node.classList.toggle('is-locked', Boolean(widget.locked));
        node.dataset.widgetId = widget.id;
        node.setAttribute('aria-selected', String(this.selection === widget.id));
        node.style.left = `${Number(geometry.x || 0)}px`;
        node.style.top = `${Number(geometry.y || 0)}px`;
        node.style.width = `${Number(geometry.width || 120)}px`;
        node.style.height = `${Number(geometry.height || 64)}px`;
        if (style.fill) node.style.setProperty('--fill', style.fill);
        if (style.stroke) node.style.setProperty('--stroke', style.stroke);
        if (style.strokeWidth) node.style.setProperty('--stroke-width', String(style.strokeWidth));
        this.renderWidgetContent(node, widget);
        this.renderResizeHandles(node, widget);
        node.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        node.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.editWidget(widget);
        });
        return node;
    },

    canResizeWidget(widget) {
        if (!widget || widget.locked) return false;
        return ['shape', 'line', 'card', 'text'].includes(String(widget.type || 'shape').trim() || 'shape');
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
        if (widget.type === 'quiz' || widget.type === 'vote') {
            const title = document.createElement('div');
            title.className = 'webmeet-blackboard-widget-title';
            title.textContent = widget.properties?.prompt || widget.properties?.question || widget.type;
            const control = document.createElement('div');
            control.className = 'webmeet-blackboard-widget-control';
            const select = document.createElement('select');
            for (const option of Array.isArray(widget.properties?.options) ? widget.properties.options : []) {
                const optionEl = document.createElement('option');
                optionEl.value = String(option);
                optionEl.textContent = String(option);
                select.append(optionEl);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Submit';
            button.addEventListener('pointerdown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.submitInteractiveWidget(widget, {value: select.value});
            });
            control.append(select, button);
            node.append(title, control);
            return;
        }
        if (widget.type === 'input') {
            const title = document.createElement('div');
            title.className = 'webmeet-blackboard-widget-title';
            title.textContent = widget.properties?.label || 'Input';
            const control = document.createElement('div');
            control.className = 'webmeet-blackboard-widget-control';
            const input = document.createElement('input');
            input.placeholder = widget.properties?.placeholder || '';
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Submit';
            button.addEventListener('pointerdown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.submitInteractiveWidget(widget, {value: input.value});
            });
            control.append(input, button);
            node.append(title, control);
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
            node.append(text);
            return;
        }
        node.textContent = this.getWidgetLabel(widget);
    },

    createSvgElement(tagName) {
        return document.createElementNS('http://www.w3.org/2000/svg', tagName);
    },

    createShapeSvg(widget) {
        const shapeKind = String(widget.properties?.shapeKind || 'rectangle').trim() || 'rectangle';
        const style = widget.properties?.style || {};
        const fill = style.fill || '#ffffff';
        const stroke = style.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || 2) || 2;
        const svg = this.createSvgElement('svg');
        svg.setAttribute('class', 'webmeet-blackboard-shape-svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        let shape = null;
        if (shapeKind === 'ellipse') {
            shape = this.createSvgElement('ellipse');
            shape.setAttribute('cx', '50');
            shape.setAttribute('cy', '50');
            shape.setAttribute('rx', '47');
            shape.setAttribute('ry', '47');
        } else if (shapeKind === 'diamond') {
            shape = this.createSvgElement('polygon');
            shape.setAttribute('points', '50,3 97,50 50,97 3,50');
        } else if (shapeKind === 'triangle') {
            shape = this.createSvgElement('polygon');
            shape.setAttribute('points', '50,4 96,96 4,96');
        } else {
            shape = this.createSvgElement('rect');
            shape.setAttribute('x', '3');
            shape.setAttribute('y', '3');
            shape.setAttribute('width', '94');
            shape.setAttribute('height', '94');
            if (shapeKind === 'rounded') {
                shape.setAttribute('rx', '12');
                shape.setAttribute('ry', '12');
            }
        }
        shape.setAttribute('fill', fill);
        shape.setAttribute('stroke', stroke);
        shape.setAttribute('stroke-width', String(strokeWidth));
        svg.append(shape);
        return svg;
    },

    createLineSvg(widget) {
        const geometry = widget.properties?.geometry || {};
        const style = widget.properties?.style || {};
        const width = Math.max(1, Number(geometry.width || 220) || 220);
        const height = Math.max(1, Number(geometry.height || 80) || 80);
        const line = widget.properties?.line || {};
        const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
        const x1 = Number(line.x1 ?? endpoints.x1);
        const y1 = Number(line.y1 ?? endpoints.y1);
        const x2 = Number(line.x2 ?? endpoints.x2);
        const y2 = Number(line.y2 ?? endpoints.y2);
        const markerStart = String(line.markerStart || '').trim();
        const markerEnd = String(line.markerEnd || '').trim();
        const stroke = style.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || 3) || 3;
        const markerIdBase = `bb_arrow_${String(widget.id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const svg = this.createSvgElement('svg');
        svg.setAttribute('class', 'webmeet-blackboard-line-svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        if (markerStart === 'arrow' || markerEnd === 'arrow') {
            const defs = this.createSvgElement('defs');
            const marker = this.createSvgElement('marker');
            marker.setAttribute('id', markerIdBase);
            marker.setAttribute('viewBox', '0 0 10 10');
            marker.setAttribute('refX', '8');
            marker.setAttribute('refY', '5');
            marker.setAttribute('markerWidth', '7');
            marker.setAttribute('markerHeight', '7');
            marker.setAttribute('orient', 'auto-start-reverse');
            const path = this.createSvgElement('path');
            path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
            path.setAttribute('fill', stroke);
            marker.append(path);
            defs.append(marker);
            svg.append(defs);
        }
        const segment = this.createSvgElement('line');
        segment.setAttribute('x1', String(x1));
        segment.setAttribute('y1', String(y1));
        segment.setAttribute('x2', String(x2));
        segment.setAttribute('y2', String(y2));
        segment.setAttribute('stroke', stroke);
        segment.setAttribute('stroke-width', String(strokeWidth));
        segment.setAttribute('stroke-linecap', 'round');
        if (markerStart === 'arrow') {
            segment.setAttribute('marker-start', `url(#${markerIdBase})`);
        }
        if (markerEnd === 'arrow') {
            segment.setAttribute('marker-end', `url(#${markerIdBase})`);
        }
        svg.append(segment);
        return svg;
    },

    getWidgetLabel(widget) {
        if (widget.type === 'text') return widget.properties?.text || '';
        if (widget.type === 'quiz' || widget.type === 'vote') return widget.properties?.prompt || widget.type;
        if (widget.type === 'input') return widget.properties?.label || '';
        return widget.properties?.label || '';
    }
};

export class WebMeetBlackboardPanel {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.adapter = null;
        this.blackboard = {widgets: []};
        this.widgetNodes = new Map();
        this.selection = '';
        this.activeTool = 'select';
        this.viewport = {x: 0, y: 0, scale: 1};
        this.dragState = null;
        this.resizeState = null;
        this.unsubscribeAdapter = null;
        this.widgetCreateOffset = 0;
        this.busy = false;
        this.inlineEditWidgetId = '';

        this.bindPointerHandlers();
        this.handleConnectEvent = (event) => this.connect(event.detail || {});
        this.handleUpdateEvent = (event) => this.applyBlackboardUpdate(event.detail || {});
        this.handleDisconnectEvent = () => this.cleanup();
        this.handleToolbarToolEvent = (event) => this.setActiveTool(event.detail?.tool);
        this.handleToolbarAddWidgetEvent = (event) => {
            void this.addWidget(event.detail?.type);
        };
        this.handleToolbarActionEvent = (event) => {
            if (event.detail?.action === 'delete') void this.deleteSelectedWidget();
            if (event.detail?.action === 'undo') void this.undo();
            if (event.detail?.action === 'redo') void this.redo();
        };
        this.handleToolbarBackgroundEvent = (event) => {
            void this.setBlackboardBackground(event.detail?.background);
        };
        this.handleEditorSaveEvent = (event) => this.saveEditorPatch(event);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindHostEvents();
        this.bindToolbar();
        this.connectAdapter();
        this.renderWidgets();
        requestAnimationFrame(() => this.updateToolbarState());
        this.element.dispatchEvent(new CustomEvent('webmeet-blackboard-panel-ready', {
            bubbles: true,
            composed: false,
            detail: { panel: this.element }
        }));
    }

    bindPointerHandlers() {
        this.handleLocalDrag = this.handleLocalDrag.bind(this);
        this.finishLocalDrag = this.finishLocalDrag.bind(this);
        this.cancelLocalDrag = this.cancelLocalDrag.bind(this);
        this.handleLocalResize = this.handleLocalResize.bind(this);
        this.finishLocalResize = this.finishLocalResize.bind(this);
        this.cancelLocalResize = this.cancelLocalResize.bind(this);
    }

    cacheElements() {
        this.board = this.element.querySelector('[data-role="board"]');
        this.toolbar = this.element.querySelector('webmeet-blackboard-toolbar');
        this.editor = this.element.querySelector('webmeet-blackboard-widget-editor');
        this.resultsPanel = this.element.querySelector('webmeet-blackboard-results-panel');
    }

    bindHostEvents() {
        this.element.removeEventListener('webmeet-blackboard-connect', this.handleConnectEvent);
        this.element.removeEventListener('webmeet-blackboard-update', this.handleUpdateEvent);
        this.element.removeEventListener('webmeet-blackboard-disconnect', this.handleDisconnectEvent);
        this.element.addEventListener('webmeet-blackboard-connect', this.handleConnectEvent);
        this.element.addEventListener('webmeet-blackboard-update', this.handleUpdateEvent);
        this.element.addEventListener('webmeet-blackboard-disconnect', this.handleDisconnectEvent);
    }

    bindToolbar() {
        this.toolbar?.removeEventListener('blackboard-tool', this.handleToolbarToolEvent);
        this.toolbar?.removeEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.removeEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.removeEventListener('blackboard-background', this.handleToolbarBackgroundEvent);
        this.toolbar?.addEventListener('blackboard-tool', this.handleToolbarToolEvent);
        this.toolbar?.addEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.addEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.addEventListener('blackboard-background', this.handleToolbarBackgroundEvent);
        this.editor?.removeEventListener('blackboard-editor-save', this.handleEditorSaveEvent);
        this.editor?.addEventListener('blackboard-editor-save', this.handleEditorSaveEvent);
    }

    connect({adapter, blackboard} = {}) {
        if (adapter && adapter !== this.adapter) {
            this.unsubscribeAdapter?.();
            this.unsubscribeAdapter = null;
            this.adapter = adapter;
        }
        this.applyBlackboard(blackboard);
        this.connectAdapter();
        return this;
    }

    connectAdapter() {
        if (!this.adapter || this.unsubscribeAdapter) return;
        this.unsubscribeAdapter = this.adapter.subscribe((payload) => {
            if (payload.kind === 'blackboard') {
                this.blackboard = payload.object || {widgets: []};
                this.renderWidgets();
            } else if (payload.kind === 'widget') {
                this.applyWidgetObject(payload.object);
            }
        });
    }

    applyBlackboardUpdate(detail = {}) {
        if (detail?.blackboard) {
            this.applyBlackboard(detail.blackboard);
            return;
        }
        if (detail?.widget) {
            this.applyWidgetObject(detail.widget);
            return;
        }
        if (detail?.object?.id) {
            this.applyWidgetObject(detail.object);
        }
    }

    applyBlackboard(blackboard) {
        if (blackboard) this.blackboard = blackboard;
        this.renderWidgets();
    }

    applyWidgetObject(widget) {
        if (!widget?.id) return;
        const widgets = Array.isArray(this.blackboard?.widgets) ? [...this.blackboard.widgets] : [];
        const index = widgets.findIndex((entry) => String(entry?.id || '') === String(widget.id));
        if (index >= 0) {
            widgets[index] = widget;
        } else {
            widgets.push(widget);
        }
        this.blackboard = {...(this.blackboard || {}), widgets};
        this.renderWidgets();
    }

    saveEditorPatch(event) {
        const targetRef = String(event.detail?.widgetId || '').trim();
        if (!targetRef || !event.detail?.patch) return;
        void this.runFinalChange({
            changeType: 'update',
            targetType: 'widget',
            targetRef,
            reason: 'edit',
            patch: event.detail.patch
        });
    }

    cleanup() {
        this.unsubscribeAdapter?.();
        this.unsubscribeAdapter = null;
    }
}

Object.assign(
    WebMeetBlackboardPanel.prototype,
    blackboardGeometryMethods,
    blackboardRenderingMethods,
    blackboardInteractionMethods,
    blackboardActionMethods
);
