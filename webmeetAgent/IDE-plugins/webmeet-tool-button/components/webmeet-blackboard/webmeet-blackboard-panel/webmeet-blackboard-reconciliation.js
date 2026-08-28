export const blackboardReconciliationMethods = {
    createWidgetRenderKey(widget, ordinal = 0) {
        const projectedWidget = this.projectAttachedConnection(widget);
        const widgetId = String(widget?.id || '');
        const isScripta = widget?.type === 'scripta-document';
        return JSON.stringify({
            widget: projectedWidget,
            themeId: String(this.getBlackboardTheme?.()?.id || ''),
            selected: this.selection === widgetId,
            selectedGroup: Boolean(widget?.groupId && widget.groupId === this.selectedGroupId),
            multiSelected: this.selectedWidgetIds?.has?.(widgetId) === true,
            fullscreen: this.fullscreenWidgetId === widgetId,
            ordinal: this.roboOrdinalMode ? Number(ordinal || 0) : 0,
            ...(isScripta ? {
                scriptaDraft: this.scriptaDraft,
                pendingScriptaDraft: this.pendingScriptaDraft,
                meetingNotesActivity: this.meetingNotesActivity,
            } : {}),
        });
    },

    getInteractionProtectedWidgetIds() {
        const protectedIds = new Set();
        const addWidget = (value) => {
            const widgetId = String(value?.widget?.id || value?.widgetId || value?.id || '').trim();
            if (widgetId) protectedIds.add(widgetId);
        };
        if (this.inlineEditWidgetId) protectedIds.add(String(this.inlineEditWidgetId));
        for (const state of [this.dragState, this.resizeState, this.rotateState]) addWidget(state);
        for (const state of [this.groupDragState, this.groupResizeState, this.groupRotateState]) {
            const groupId = String(state?.groupId || '').trim();
            if (!groupId) continue;
            for (const widget of this.getGroupMembers?.(groupId) || []) addWidget(widget);
        }
        for (const widgetId of this.workspaceDropState?.widgetIds || []) protectedIds.add(String(widgetId));

        const activeElement = typeof document === 'undefined' ? null : document.activeElement;
        if (activeElement?.matches?.('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) {
            const activeWidgetId = String(activeElement.closest?.('[data-widget-id]')?.dataset?.widgetId || '').trim();
            if (activeWidgetId) protectedIds.add(activeWidgetId);
        }
        return protectedIds;
    },

    clearTransientBoardDecorations({preserveGroupInteraction = false} = {}) {
        const selector = [
            ...(!preserveGroupInteraction ? [
                '.webmeet-blackboard-group-hit-area',
                '.webmeet-blackboard-group-ordinal',
                '.webmeet-blackboard-group-overlay',
            ] : []),
            '.webmeet-blackboard-connection-anchor',
        ].join(',');
        for (const node of this.board?.querySelectorAll?.(selector) || []) node.remove();
        if (!preserveGroupInteraction) this.groupOverlay = null;
        this.connectionSnapTarget = null;
    },

    orderWidgetNodes(widgets = []) {
        let widgetIndex = 0;
        for (const widget of widgets) {
            const node = this.widgetNodes.get(String(widget?.id || ''));
            if (!node) continue;
            const currentNode = Array.from(this.board.children || [])[widgetIndex] || null;
            if (currentNode !== node) this.board.insertBefore(node, currentNode);
            widgetIndex += 1;
        }
    },
};
