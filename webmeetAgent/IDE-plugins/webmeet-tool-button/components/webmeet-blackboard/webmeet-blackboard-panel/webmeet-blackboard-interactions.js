export const blackboardInteractionMethods = {
    handleBoardPointerDownCapture(event) {
        if (!this.board || event.button !== 0) return;
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !this.board.contains(target)) return;
        if (this.pendingWidgetType) {
            const type = this.pendingWidgetType;
            const position = this.getBoardPointFromEvent(event);
            event.preventDefault();
            event.stopPropagation();
            if (this.canDrawPendingWidget(type) && position) {
                this.beginPendingWidgetDraw(event, type, position);
            } else {
                this.setPendingWidgetType('');
                void this.addWidget(type, position);
            }
            return;
        }
        const widgetNode = target.closest?.('.webmeet-blackboard-widget') || null;
        const nextSelection = String(widgetNode?.dataset?.widgetId || '').trim();
        if (this.selection === nextSelection) return;
        const previousSelection = this.selection;
        this.selection = nextSelection;
        if (previousSelection && previousSelection !== this.selection) {
            const previousNode = this.widgetNodes.get(previousSelection);
            if (previousNode) {
                previousNode.setAttribute('aria-selected', 'false');
            }
        }
        if (this.selection) {
            const nextNode = this.widgetNodes.get(this.selection);
            if (nextNode) {
                nextNode.setAttribute('aria-selected', 'true');
            }
        }
        this.updateToolbarState();
    },

    canDrawPendingWidget(type = '') {
        const normalizedType = String(type || '').trim().split(':')[0];
        return normalizedType === 'shape' || normalizedType === 'line';
    },

    beginPendingWidgetDraw(event, type, startPoint) {
        this.pendingCreateDragState = {
            type,
            pointerId: event.pointerId,
            startPoint,
            endPoint: startPoint,
            previewNode: this.createPendingWidgetPreview(type)
        };
        if (this.pendingCreateDragState.previewNode) {
            this.board?.append?.(this.pendingCreateDragState.previewNode);
            this.updatePendingWidgetPreview(this.pendingCreateDragState, startPoint);
        }
        this.board?.setPointerCapture?.(event.pointerId);
        this.board?.addEventListener?.('pointermove', this.handlePendingWidgetDrawMove);
        this.board?.addEventListener?.('pointerup', this.finishPendingWidgetDraw);
        this.board?.addEventListener?.('pointercancel', this.cancelPendingWidgetDraw);
    },

    handlePendingWidgetDrawMove(event) {
        if (!this.pendingCreateDragState) return;
        const point = this.getBoardPointFromEvent(event);
        if (!point) return;
        this.pendingCreateDragState.endPoint = point;
        this.updatePendingWidgetPreview(this.pendingCreateDragState, point);
    },

    async finishPendingWidgetDraw(event) {
        if (!this.pendingCreateDragState) return;
        const state = this.pendingCreateDragState;
        const endPoint = this.getBoardPointFromEvent(event) || state.endPoint || state.startPoint;
        this.detachPendingWidgetDrawListeners();
        this.removePendingWidgetPreview(state);
        this.pendingCreateDragState = null;
        this.setPendingWidgetType('');
        const placement = this.getPendingWidgetPlacement(state.type, state.startPoint, endPoint);
        await this.addWidget(state.type, placement || state.startPoint);
    },

    cancelPendingWidgetDraw() {
        if (!this.pendingCreateDragState) return;
        this.removePendingWidgetPreview(this.pendingCreateDragState);
        this.detachPendingWidgetDrawListeners();
        this.pendingCreateDragState = null;
        this.setPendingWidgetType('');
    },

    detachPendingWidgetDrawListeners() {
        this.board?.removeEventListener?.('pointermove', this.handlePendingWidgetDrawMove);
        this.board?.removeEventListener?.('pointerup', this.finishPendingWidgetDraw);
        this.board?.removeEventListener?.('pointercancel', this.cancelPendingWidgetDraw);
    },

    createPendingWidgetPreview(type = '') {
        if (typeof document === 'undefined') return null;
        const rawType = String(type || '').trim();
        const [normalizedType, variant = ''] = rawType.split(':');
        const preview = document.createElement('div');
        preview.className = `webmeet-blackboard-create-preview ${normalizedType}`;
        if (normalizedType === 'shape') {
            preview.classList.add(`shape-${variant || 'rectangle'}`);
        }
        if (normalizedType === 'line') {
            preview.classList.add(`line-${variant || 'line'}`);
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'webmeet-blackboard-create-preview-line-svg');
            svg.setAttribute('preserveAspectRatio', 'none');
            const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
            const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            marker.setAttribute('id', 'webmeetBlackboardCreatePreviewArrow');
            marker.setAttribute('viewBox', '0 0 10 10');
            marker.setAttribute('refX', '9');
            marker.setAttribute('refY', '5');
            marker.setAttribute('markerWidth', '7');
            marker.setAttribute('markerHeight', '7');
            marker.setAttribute('orient', 'auto-start-reverse');
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
            marker.append(path);
            defs.append(marker);
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('class', 'webmeet-blackboard-create-preview-line');
            if (variant === 'arrow-end' || variant === 'arrow-both') {
                line.setAttribute('marker-end', 'url(#webmeetBlackboardCreatePreviewArrow)');
            }
            if (variant === 'arrow-both') {
                line.setAttribute('marker-start', 'url(#webmeetBlackboardCreatePreviewArrow)');
            }
            svg.append(defs, line);
            preview.append(svg);
        }
        return preview;
    },

    updatePendingWidgetPreview(state, endPoint) {
        const preview = state?.previewNode;
        if (!preview) return;
        const placement = this.getPendingWidgetPlacement(state.type, state.startPoint, endPoint);
        if (!placement) return;
        if (placement.kind !== 'draw') {
            preview.style.left = `${Math.round(placement.x)}px`;
            preview.style.top = `${Math.round(placement.y)}px`;
            preview.style.width = '1px';
            preview.style.height = '1px';
            return;
        }
        const normalizedType = String(state.type || '').trim().split(':')[0];
        if (normalizedType === 'line') {
            this.updatePendingLinePreview(preview, placement);
            return;
        }
        preview.style.left = `${Math.round(Math.max(0, placement.x))}px`;
        preview.style.top = `${Math.round(Math.max(0, placement.y))}px`;
        preview.style.width = `${Math.max(1, Math.round(placement.width))}px`;
        preview.style.height = `${Math.max(1, Math.round(placement.height))}px`;
    },

    updatePendingLinePreview(preview, placement) {
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
        preview.style.left = `${Math.round(Math.max(0, x))}px`;
        preview.style.top = `${Math.round(Math.max(0, y))}px`;
        preview.style.width = `${Math.round(width)}px`;
        preview.style.height = `${Math.round(height)}px`;
        const svg = preview.querySelector?.('.webmeet-blackboard-create-preview-line-svg');
        const line = svg?.querySelector?.('.webmeet-blackboard-create-preview-line');
        svg?.setAttribute('viewBox', `0 0 ${width} ${height}`);
        line?.setAttribute('x1', String(x1 - x));
        line?.setAttribute('y1', String(y1 - y));
        line?.setAttribute('x2', String(x2 - x));
        line?.setAttribute('y2', String(y2 - y));
    },

    removePendingWidgetPreview(state) {
        state?.previewNode?.remove?.();
    },

    getPendingWidgetPlacement(type, startPoint, endPoint) {
        const startX = Number(startPoint?.x);
        const startY = Number(startPoint?.y);
        const endX = Number(endPoint?.x);
        const endY = Number(endPoint?.y);
        if (![startX, startY, endX, endY].every(Number.isFinite)) return null;
        const dx = endX - startX;
        const dy = endY - startY;
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) {
            return { x: startX, y: startY };
        }
        const normalizedType = String(type || '').trim().split(':')[0];
        if (normalizedType === 'line') {
            return {
                kind: 'draw',
                x1: startX,
                y1: startY,
                x2: endX,
                y2: endY
            };
        }
        return {
            kind: 'draw',
            x: Math.min(startX, endX),
            y: Math.min(startY, endY),
            width: Math.abs(dx),
            height: Math.abs(dy)
        };
    },

    getBoardPointFromEvent(event) {
        const rect = this.board?.getBoundingClientRect?.();
        if (!rect) return null;
        const scale = Number(this.viewport?.scale || 1) || 1;
        const viewportX = Number(this.viewport?.x || 0) || 0;
        const viewportY = Number(this.viewport?.y || 0) || 0;
        const scrollX = Number(this.board?.scrollLeft || 0) || 0;
        const scrollY = Number(this.board?.scrollTop || 0) || 0;
        const x = (Number(event.clientX || 0) - Number(rect.left || 0) + scrollX - viewportX) / scale;
        const y = (Number(event.clientY || 0) - Number(rect.top || 0) + scrollY - viewportY) / scale;
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return {
            x: Math.max(0, x),
            y: Math.max(0, y)
        };
    },

    beginLocalDrag(event, widget) {
        if (!widget || widget.locked) return;
        this.selection = widget.id;
        this.updateToolbarState();
        if (this.activeTool !== 'select') return;
        if (event.target?.closest?.('.webmeet-blackboard-context-menu') && !event.target?.closest?.('[data-context-action="move"]')) return;
        if (event.target?.closest?.('.webmeet-blackboard-inline-text')) return;
        if (event.target?.closest?.('[data-resize-handle]')) return;
        event.preventDefault();
        event.stopPropagation();
        const node = event.currentTarget?.classList?.contains('webmeet-blackboard-widget')
            ? event.currentTarget
            : event.currentTarget?.closest?.('.webmeet-blackboard-widget');
        if (!node) return;
        node.focus?.({preventScroll: true});
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
        if (!widget || !this.canResizeWidget(widget)) return;
        this.selection = widget.id;
        this.updateToolbarState();
        if (this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        const node = event.currentTarget.closest('.webmeet-blackboard-widget');
        if (!node) return;
        node.focus?.({preventScroll: true});
        const geometry = widget.properties?.geometry || {};
        const minimumSize = this.getWidgetMinimumSize(widget);
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
            originHeight: Number(geometry.height || 64),
            ...minimumSize
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
    },

    beginLocalRotate(event, widget) {
        if (!widget || !this.canRotateWidget(widget)) return;
        if (this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        this.selection = widget.id;
        this.updateToolbarState();
        const node = event.currentTarget.closest('.webmeet-blackboard-widget');
        if (!node) return;
        node.focus?.({preventScroll: true});
        this.rotateState = {
            widget,
            node,
            pointerId: event.pointerId,
            startY: event.clientY,
            originRotation: this.getWidgetRotation(widget),
            nextRotation: this.getWidgetRotation(widget),
            didMove: false
        };
        node.setPointerCapture?.(event.pointerId);
        node.addEventListener('pointermove', this.handleLocalRotate);
        node.addEventListener('pointerup', this.finishLocalRotate);
        node.addEventListener('pointercancel', this.cancelLocalRotate);
    },

    handleLocalRotate(event) {
        if (!this.rotateState) return;
        const deltaY = event.clientY - this.rotateState.startY;
        const nextRotation = this.rotateState.originRotation + deltaY;
        this.rotateState.nextRotation = nextRotation;
        this.rotateState.didMove = Math.abs(deltaY) > 2;
        this.rotateState.node.style.transform = `rotate(${nextRotation}deg)`;
        this.rotateState.node.style.setProperty('--widget-rotation', `${nextRotation}deg`);
        this.rotateState.node.style.setProperty('--widget-counter-rotation', `${-nextRotation}deg`);
    },

    async finishLocalRotate(event) {
        if (!this.rotateState) return;
        const {widget, node, nextRotation, didMove} = this.rotateState;
        this.detachRotateListeners(node);
        this.rotateState = null;
        if (!didMove) {
            await this.rotateWidgetByStep(widget, event?.shiftKey ? -15 : 15);
            return;
        }
        const response = await this.adapter?.sendChange({
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
        if (response?.blackboard) {
            this.blackboard = response.blackboard;
            this.renderWidgets();
        }
    },

    cancelLocalRotate() {
        if (!this.rotateState) return;
        const {node, originRotation} = this.rotateState;
        node.style.transform = originRotation ? `rotate(${originRotation}deg)` : '';
        node.style.setProperty('--widget-rotation', `${originRotation}deg`);
        node.style.setProperty('--widget-counter-rotation', `${-originRotation}deg`);
        this.detachRotateListeners(node);
        this.rotateState = null;
    },

    detachRotateListeners(node) {
        node.removeEventListener('pointermove', this.handleLocalRotate);
        node.removeEventListener('pointerup', this.finishLocalRotate);
        node.removeEventListener('pointercancel', this.cancelLocalRotate);
    }
};
