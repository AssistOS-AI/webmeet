const GROUPABLE_WIDGET_TYPES = new Set(['shape', 'line', 'text', 'image', 'card']);
export const GROUP_SELECTION_PADDING = 8;

export function padGroupSelectionBounds(bounds = {}, padding = GROUP_SELECTION_PADDING) {
    const gap = Math.max(0, Number(padding) || 0);
    return {
        x: Number(bounds.x || 0) - gap,
        y: Number(bounds.y || 0) - gap,
        width: Math.max(1, Number(bounds.width || 0) + gap * 2),
        height: Math.max(1, Number(bounds.height || 0) + gap * 2),
    };
}

function applyGroupSelectionBounds(overlay, bounds) {
    if (!overlay || !bounds) return;
    const padded = padGroupSelectionBounds(bounds);
    Object.assign(overlay.style, {
        left: `${padded.x}px`, top: `${padded.y}px`, width: `${padded.width}px`, height: `${padded.height}px`,
    });
}

function finiteGeometry(widget = {}) {
    const geometry = widget.properties?.geometry || {};
    return {
        x: Number(geometry.x || 0),
        y: Number(geometry.y || 0),
        width: Math.max(1, Number(geometry.width || 1)),
        height: Math.max(1, Number(geometry.height || 1)),
        rotation: Number(widget.properties?.rotation ?? geometry.rotation ?? 0),
    };
}

function boundsForWidgets(widgets = []) {
    const transformable = widgets.filter((widget) => !widget.properties?.connection);
    if (!transformable.length) return null;
    const geometries = transformable.map(finiteGeometry);
    const x = Math.min(...geometries.map((geometry) => geometry.x));
    const y = Math.min(...geometries.map((geometry) => geometry.y));
    const right = Math.max(...geometries.map((geometry) => geometry.x + geometry.width));
    const bottom = Math.max(...geometries.map((geometry) => geometry.y + geometry.height));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y)};
}

function intersects(a, b) {
    return a.x <= b.x + b.width && a.x + a.width >= b.x
        && a.y <= b.y + b.height && a.y + a.height >= b.y;
}

export const blackboardGroupMethods = {
    getRoboTargetOrdinals(widgets = this.blackboard?.widgets || []) {
        const widgetOrdinals = new Map();
        const groupOrdinals = new Map();
        let nextOrdinal = 0;
        for (const widget of widgets) {
            const groupId = String(widget.groupId || '');
            if (groupId) {
                if (!groupOrdinals.has(groupId)) groupOrdinals.set(groupId, ++nextOrdinal);
                continue;
            }
            widgetOrdinals.set(String(widget.id || ''), ++nextOrdinal);
        }
        return {widgetOrdinals, groupOrdinals};
    },

    isGroupableWidget(widget) {
        return GROUPABLE_WIDGET_TYPES.has(String(widget?.type || ''));
    },

    decorateWidgetGroupSelection(node, widget) {
        const groupSelected = Boolean(widget.groupId && widget.groupId === this.selectedGroupId);
        const multiSelected = this.selectedWidgetIds?.has?.(String(widget.id)) === true;
        node.classList.toggle('is-group-member', Boolean(widget.groupId));
        node.classList.toggle('is-group-selected-member', groupSelected);
        node.classList.toggle('is-multi-selected', multiSelected);
        return multiSelected;
    },

    getGroupMembers(groupId = this.selectedGroupId) {
        const normalized = String(groupId || '').trim();
        return (this.blackboard?.widgets || []).filter((widget) => String(widget.groupId || '') === normalized);
    },

    getSelectedWidgets() {
        const ids = this.selectedWidgetIds || new Set();
        return (this.blackboard?.widgets || []).filter((widget) => (
            ids.has(String(widget.id)) && !widget.groupId && this.isGroupableWidget(widget)
        ));
    },

    clearGroupSelection() {
        this.closeGroupExportMenu?.();
        this.selectedGroupId = '';
        this.selectedWidgetIds?.clear?.();
        this.groupOverlay?.remove?.();
        this.groupOverlay = null;
        for (const node of this.widgetNodes?.values?.() || []) {
            node.classList.remove('is-group-selected-member', 'is-multi-selected');
        }
    },

    selectGroup(groupId, representativeId = '') {
        const members = this.getGroupMembers(groupId);
        if (members.length < 2) return false;
        this.selectedWidgetIds.clear();
        this.selectedGroupId = String(groupId);
        this.selection = String(representativeId || members.at(-1)?.id || '');
        for (const widget of members) this.widgetNodes.get(widget.id)?.classList?.add?.('is-group-selected-member');
        this.renderSelectionOverlay();
        this.updateToolbarState();
        return true;
    },

    toggleWidgetMultiSelection(widget) {
        if (!widget?.id || widget.groupId || !this.isGroupableWidget(widget)) return false;
        this.selectedGroupId = '';
        const id = String(widget.id);
        if (this.selectedWidgetIds.has(id)) this.selectedWidgetIds.delete(id);
        else this.selectedWidgetIds.add(id);
        this.selection = this.selectedWidgetIds.has(id) ? id : [...this.selectedWidgetIds].at(-1) || '';
        this.renderWidgets();
        return true;
    },

    renderGroupHitAreas(groupOrdinals = new Map()) {
        const groups = new Map();
        for (const widget of this.blackboard?.widgets || []) {
            const groupId = String(widget.groupId || '');
            if (!groupId) continue;
            if (!groups.has(groupId)) groups.set(groupId, []);
            groups.get(groupId).push(widget);
        }
        for (const [groupId, members] of groups) {
            if (members.length < 2) continue;
            const bounds = boundsForWidgets(members);
            if (!bounds) continue;
            const hitArea = document.createElement('div');
            hitArea.className = 'webmeet-blackboard-group-hit-area';
            hitArea.dataset.groupId = groupId;
            hitArea.style.left = `${bounds.x}px`;
            hitArea.style.top = `${bounds.y}px`;
            hitArea.style.width = `${bounds.width}px`;
            hitArea.style.height = `${bounds.height}px`;
            hitArea.setAttribute('aria-hidden', 'true');
            this.board.append(hitArea);
            const ordinal = Number(groupOrdinals.get(groupId) || 0);
            if (this.roboOrdinalMode && ordinal > 0) {
                const badge = document.createElement('span');
                badge.className = 'webmeet-blackboard-widget-ordinal webmeet-blackboard-group-ordinal';
                badge.textContent = `G${ordinal}`;
                badge.style.left = `${bounds.x + 15}px`;
                badge.style.top = `${bounds.y - 5}px`;
                badge.setAttribute('aria-hidden', 'true');
                this.board.append(badge);
            }
        }
    },

    renderSelectionOverlay() {
        this.board?.querySelector?.('.webmeet-blackboard-group-overlay')?.remove?.();
        this.groupOverlay = null;
        const grouped = Boolean(this.selectedGroupId);
        const widgets = grouped ? this.getGroupMembers() : this.getSelectedWidgets();
        if ((grouped && widgets.length < 2) || (!grouped && widgets.length < 2)) return;
        const bounds = boundsForWidgets(widgets);
        if (!bounds) return;
        const overlay = document.createElement('div');
        overlay.className = `webmeet-blackboard-group-overlay ${grouped ? 'is-group' : 'is-multi-selection'}`;
        overlay.dataset.groupId = grouped ? this.selectedGroupId : '';
        applyGroupSelectionBounds(overlay, bounds);
        overlay.setAttribute('aria-label', grouped ? 'Selected widget group' : 'Selected widgets');
        if (grouped) {
            this.renderGroupContextMenu(overlay, widgets);
            this.renderGroupResizeHandles(overlay);
        } else {
            const menu = document.createElement('div');
            menu.className = 'webmeet-blackboard-context-menu webmeet-blackboard-group-menu';
            menu.addEventListener('pointerdown', (event) => event.stopPropagation());
            const groupButton = this.createContextButton('group', 'Group selected widgets', 'Group', 'group');
            groupButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.groupSelectedWidgets();
            });
            menu.append(groupButton);
            overlay.append(menu);
        }
        this.board.append(overlay);
        this.groupOverlay = overlay;
    },

    renderGroupContextMenu(overlay, members) {
        this.closeGroupExportMenu?.();
        const menu = document.createElement('div');
        menu.className = 'webmeet-blackboard-context-menu webmeet-blackboard-group-menu';
        menu.setAttribute('aria-label', 'Group actions');
        menu.addEventListener('pointerdown', (event) => event.stopPropagation());
        const representative = members.at(-1);
        const move = this.createContextButton('move', 'Move group', 'Move group', 'move');
        move.addEventListener('pointerdown', (event) => this.beginGroupDrag(event, this.selectedGroupId, representative));
        const rotate = this.createContextButton('rotate', 'Rotate group', 'Rotate group', 'rotate');
        rotate.addEventListener('pointerdown', (event) => this.beginGroupRotate(event, this.selectedGroupId));
        const exportButton = this.createContextButton('export', 'Export group', 'Export group', 'export');
        exportButton.setAttribute('aria-haspopup', 'menu');
        exportButton.setAttribute('aria-expanded', 'false');
        exportButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleGroupExportMenu(menu, exportButton);
        });
        const remove = this.createContextButton('delete', 'Delete group', 'Delete group', 'delete');
        remove.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.deleteSelectedGroup();
        });
        const ungroup = this.createContextButton('ungroup', 'Ungroup widgets', 'Ungroup widgets', 'ungroup');
        ungroup.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.ungroupSelectedGroup();
        });
        menu.append(move, rotate, exportButton, remove, ungroup);
        overlay.append(menu);
    },

    renderGroupResizeHandles(overlay) {
        for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const node = document.createElement('span');
            node.className = `webmeet-blackboard-resize-handle group-resize ${handle}`;
            node.dataset.groupResizeHandle = handle;
            node.setAttribute('aria-hidden', 'true');
            node.addEventListener('pointerdown', (event) => this.beginGroupResize(event, this.selectedGroupId, handle));
            overlay.append(node);
        }
    },

    async groupSelectedWidgets() {
        const selectedWidgets = this.getSelectedWidgets();
        const widgetIds = selectedWidgets.map((widget) => String(widget.id));
        if (widgetIds.length < 2 || widgetIds.length !== this.selectedWidgetIds.size || this.busy) return;
        const representativeId = widgetIds.at(-1);
        const response = await this.runFinalChange({
            changeType: 'group',
            targetType: 'blackboard',
            reason: 'group',
            widgetIds,
        });
        const representative = this.getWidgetById(representativeId);
        this.selectedWidgetIds.clear();
        this.selectedGroupId = String(representative?.groupId || '');
        this.selection = representativeId;
        this.renderWidgets();
        return response;
    },

    async deleteSelectedGroup() {
        const groupId = String(this.selectedGroupId || '');
        if (!groupId || this.busy) return;
        await this.runFinalChange({changeType: 'delete', targetType: 'group', targetRef: groupId, reason: 'group-delete'});
        this.clearGroupSelection();
        this.selection = '';
        this.renderWidgets();
    },

    async ungroupSelectedGroup() {
        const groupId = String(this.selectedGroupId || '');
        const representativeId = String(this.selection || '');
        if (!groupId || this.busy) return;
        await this.runFinalChange({changeType: 'ungroup', targetType: 'group', targetRef: groupId, reason: 'ungroup'});
        this.clearGroupSelection();
        this.selection = representativeId;
        this.renderWidgets();
    },

    beginGroupDrag(event, groupId, representative = null) {
        const members = this.getGroupMembers(groupId);
        if (members.length < 2 || this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        this.selectGroup(groupId, representative?.id);
        const captureNode = event.currentTarget?.closest?.('.webmeet-blackboard-widget') || this.groupOverlay;
        this.groupDragState = {
            groupId,
            captureNode,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            origins: new Map(members.filter((widget) => !widget.properties?.connection).map((widget) => [widget.id, finiteGeometry(widget)])),
        };
        captureNode?.setPointerCapture?.(event.pointerId);
        captureNode?.addEventListener?.('pointermove', this.handleGroupDrag);
        captureNode?.addEventListener?.('pointerup', this.finishGroupDrag);
        captureNode?.addEventListener?.('pointercancel', this.cancelGroupDrag);
    },

    handleGroupDrag(event) {
        if (!this.groupDragState) return;
        const dx = event.clientX - this.groupDragState.startX;
        const dy = event.clientY - this.groupDragState.startY;
        for (const [id, origin] of this.groupDragState.origins) {
            const node = this.widgetNodes.get(id);
            if (!node) continue;
            node.style.left = `${origin.x + dx}px`;
            node.style.top = `${origin.y + dy}px`;
        }
        if (this.groupOverlay) {
            const bounds = boundsForWidgets(this.getGroupMembers(this.groupDragState.groupId));
            this.groupOverlay.style.left = `${bounds.x + dx}px`;
            this.groupOverlay.style.top = `${bounds.y + dy}px`;
        }
    },

    async finishGroupDrag(event) {
        const state = this.groupDragState;
        if (!state) return;
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        this.detachGroupDrag(state);
        this.groupDragState = null;
        if (!dx && !dy) return this.renderWidgets();
        try {
            await this.runFinalChange({
                changeType: 'update', targetType: 'group', targetRef: state.groupId, reason: 'group-move',
                patch: {transform: {translation: {x: dx, y: dy}}},
            });
        } finally {
            this.renderWidgets();
        }
    },

    cancelGroupDrag() {
        const state = this.groupDragState;
        if (!state) return;
        this.detachGroupDrag(state);
        this.groupDragState = null;
        this.renderWidgets();
    },

    detachGroupDrag(state) {
        state.captureNode?.removeEventListener?.('pointermove', this.handleGroupDrag);
        state.captureNode?.removeEventListener?.('pointerup', this.finishGroupDrag);
        state.captureNode?.removeEventListener?.('pointercancel', this.cancelGroupDrag);
    },

    beginGroupRotate(event, groupId) {
        const members = this.getGroupMembers(groupId);
        if (members.length < 2 || this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        const captureNode = this.groupOverlay;
        const bounds = boundsForWidgets(members);
        this.groupRotateState = {
            groupId, captureNode, pointerId: event.pointerId, startY: event.clientY, delta: 0,
            center: {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2},
            origins: new Map(members.filter((widget) => !widget.properties?.connection).map((widget) => [widget.id, finiteGeometry(widget)])),
        };
        captureNode?.setPointerCapture?.(event.pointerId);
        captureNode?.addEventListener?.('pointermove', this.handleGroupRotate);
        captureNode?.addEventListener?.('pointerup', this.finishGroupRotate);
        captureNode?.addEventListener?.('pointercancel', this.cancelGroupRotate);
    },

    handleGroupRotate(event) {
        const state = this.groupRotateState;
        if (!state) return;
        state.delta = event.clientY - state.startY;
        const radians = state.delta * Math.PI / 180;
        for (const [id, origin] of state.origins) {
            const node = this.widgetNodes.get(id);
            if (!node) continue;
            const cx = origin.x + origin.width / 2;
            const cy = origin.y + origin.height / 2;
            const ox = cx - state.center.x;
            const oy = cy - state.center.y;
            const nextX = state.center.x + ox * Math.cos(radians) - oy * Math.sin(radians);
            const nextY = state.center.y + ox * Math.sin(radians) + oy * Math.cos(radians);
            node.style.left = `${nextX - origin.width / 2}px`;
            node.style.top = `${nextY - origin.height / 2}px`;
            node.style.transform = `rotate(${origin.rotation + state.delta}deg)`;
        }
    },

    async finishGroupRotate(event) {
        const state = this.groupRotateState;
        if (!state) return;
        const dragged = Math.abs(state.delta) > 2;
        const rotationDelta = dragged ? state.delta : event.shiftKey ? -15 : 15;
        this.detachGroupRotate(state);
        this.groupRotateState = null;
        try {
            await this.runFinalChange({
                changeType: 'update', targetType: 'group', targetRef: state.groupId, reason: 'group-rotate',
                patch: {transform: {rotationDelta}},
            });
        } finally {
            this.renderWidgets();
        }
    },

    cancelGroupRotate() {
        const state = this.groupRotateState;
        if (!state) return;
        this.detachGroupRotate(state);
        this.groupRotateState = null;
        this.renderWidgets();
    },

    detachGroupRotate(state) {
        state.captureNode?.removeEventListener?.('pointermove', this.handleGroupRotate);
        state.captureNode?.removeEventListener?.('pointerup', this.finishGroupRotate);
        state.captureNode?.removeEventListener?.('pointercancel', this.cancelGroupRotate);
    },

    beginGroupResize(event, groupId, handle) {
        const members = this.getGroupMembers(groupId);
        if (members.length < 2 || this.activeTool !== 'select') return;
        event.preventDefault();
        event.stopPropagation();
        const captureNode = this.groupOverlay;
        this.groupResizeState = {
            groupId, handle, captureNode, pointerId: event.pointerId,
            startX: event.clientX, startY: event.clientY,
            bounds: boundsForWidgets(members), nextBounds: boundsForWidgets(members),
            origins: new Map(members.filter((widget) => !widget.properties?.connection).map((widget) => [widget.id, finiteGeometry(widget)])),
        };
        captureNode?.setPointerCapture?.(event.pointerId);
        captureNode?.addEventListener?.('pointermove', this.handleGroupResize);
        captureNode?.addEventListener?.('pointerup', this.finishGroupResize);
        captureNode?.addEventListener?.('pointercancel', this.cancelGroupResize);
    },

    getGroupResizedBounds(state, event) {
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        const source = state.bounds;
        let left = source.x;
        let top = source.y;
        let right = source.x + source.width;
        let bottom = source.y + source.height;
        if (state.handle.includes('w')) left = Math.min(right - 12, left + dx);
        if (state.handle.includes('e')) right = Math.max(left + 12, right + dx);
        if (state.handle.includes('n')) top = Math.min(bottom - 12, top + dy);
        if (state.handle.includes('s')) bottom = Math.max(top + 12, bottom + dy);
        if (event.shiftKey) {
            const scaleX = (right - left) / source.width;
            const scaleY = (bottom - top) / source.height;
            const scale = Math.max(scaleX, scaleY);
            if (state.handle.includes('w')) left = right - source.width * scale;
            else right = left + source.width * scale;
            if (state.handle.includes('n')) top = bottom - source.height * scale;
            else bottom = top + source.height * scale;
        }
        return {x: left, y: top, width: right - left, height: bottom - top};
    },

    handleGroupResize(event) {
        const state = this.groupResizeState;
        if (!state) return;
        const bounds = this.getGroupResizedBounds(state, event);
        state.nextBounds = bounds;
        const scaleX = bounds.width / state.bounds.width;
        const scaleY = bounds.height / state.bounds.height;
        for (const [id, origin] of state.origins) {
            const node = this.widgetNodes.get(id);
            if (!node) continue;
            node.style.left = `${bounds.x + (origin.x - state.bounds.x) * scaleX}px`;
            node.style.top = `${bounds.y + (origin.y - state.bounds.y) * scaleY}px`;
            node.style.width = `${origin.width * scaleX}px`;
            node.style.height = `${origin.height * scaleY}px`;
        }
        applyGroupSelectionBounds(this.groupOverlay, bounds);
    },

    async finishGroupResize(event) {
        const state = this.groupResizeState;
        if (!state) return;
        state.nextBounds = this.getGroupResizedBounds(state, event);
        this.detachGroupResize(state);
        this.groupResizeState = null;
        try {
            await this.runFinalChange({
                changeType: 'update', targetType: 'group', targetRef: state.groupId, reason: 'group-resize',
                patch: {transform: {resize: state.nextBounds}},
            });
        } finally {
            this.renderWidgets();
        }
    },

    cancelGroupResize() {
        const state = this.groupResizeState;
        if (!state) return;
        this.detachGroupResize(state);
        this.groupResizeState = null;
        this.renderWidgets();
    },

    detachGroupResize(state) {
        state.captureNode?.removeEventListener?.('pointermove', this.handleGroupResize);
        state.captureNode?.removeEventListener?.('pointerup', this.finishGroupResize);
        state.captureNode?.removeEventListener?.('pointercancel', this.cancelGroupResize);
    },

    beginMarqueeSelection(event) {
        const point = this.getBoardPointFromEvent(event);
        if (!point) return;
        event.preventDefault();
        event.stopPropagation();
        this.clearGroupSelection();
        const node = document.createElement('div');
        node.className = 'webmeet-blackboard-selection-marquee';
        this.board.append(node);
        this.marqueeState = {pointerId: event.pointerId, start: point, current: point, node};
        this.board.setPointerCapture?.(event.pointerId);
        this.board.addEventListener('pointermove', this.handleMarqueeSelection);
        this.board.addEventListener('pointerup', this.finishMarqueeSelection);
        this.board.addEventListener('pointercancel', this.cancelMarqueeSelection);
    },

    handleMarqueeSelection(event) {
        const state = this.marqueeState;
        if (!state) return;
        state.current = this.getBoardPointFromEvent(event) || state.current;
        const bounds = {
            x: Math.min(state.start.x, state.current.x), y: Math.min(state.start.y, state.current.y),
            width: Math.abs(state.current.x - state.start.x), height: Math.abs(state.current.y - state.start.y),
        };
        Object.assign(state.node.style, {
            left: `${bounds.x}px`, top: `${bounds.y}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
        });
    },

    finishMarqueeSelection(event) {
        const state = this.marqueeState;
        if (!state) return;
        state.current = this.getBoardPointFromEvent(event) || state.current;
        const selectionBounds = {
            x: Math.min(state.start.x, state.current.x), y: Math.min(state.start.y, state.current.y),
            width: Math.abs(state.current.x - state.start.x), height: Math.abs(state.current.y - state.start.y),
        };
        this.detachMarqueeSelection(state);
        this.marqueeState = null;
        const hits = (this.blackboard?.widgets || []).filter((widget) => (
            (widget.groupId || this.isGroupableWidget(widget)) && intersects(selectionBounds, finiteGeometry(widget))
        ));
        const groupedHit = hits.find((widget) => widget.groupId);
        if (groupedHit) this.selectGroup(groupedHit.groupId, groupedHit.id);
        else {
            this.selectedWidgetIds = new Set(hits.map((widget) => String(widget.id)));
            this.selection = [...this.selectedWidgetIds].at(-1) || '';
            this.renderWidgets();
        }
    },

    cancelMarqueeSelection() {
        const state = this.marqueeState;
        if (!state) return;
        this.detachMarqueeSelection(state);
        this.marqueeState = null;
        this.renderWidgets();
    },

    detachMarqueeSelection(state) {
        state.node?.remove?.();
        this.board.removeEventListener('pointermove', this.handleMarqueeSelection);
        this.board.removeEventListener('pointerup', this.finishMarqueeSelection);
        this.board.removeEventListener('pointercancel', this.cancelMarqueeSelection);
    },
};
