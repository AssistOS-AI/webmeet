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
