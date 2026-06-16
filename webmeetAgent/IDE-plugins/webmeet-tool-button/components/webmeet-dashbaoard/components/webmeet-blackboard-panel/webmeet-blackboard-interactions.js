export const blackboardInteractionMethods = {
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
