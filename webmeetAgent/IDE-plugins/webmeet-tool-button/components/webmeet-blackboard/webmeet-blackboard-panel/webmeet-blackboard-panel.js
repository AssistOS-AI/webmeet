import { blackboardActionMethods } from './webmeet-blackboard-actions.js';
import { blackboardGeometryMethods } from './webmeet-blackboard-geometry.js';
import { blackboardInteractionMethods } from './webmeet-blackboard-interactions.js';
import { blackboardRenderingMethods } from './webmeet-blackboard-rendering.js';

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
        this.rotateState = null;
        this.unsubscribeAdapter = null;
        this.widgetCreateOffset = 0;
        this.busy = false;
        this.inlineEditWidgetId = '';
        this.inlineEditState = null;
        this.inlineEditCommitPromise = null;
        this.pendingRenderAfterInlineEdit = false;

        this.bindPointerHandlers();
        this.handleConnectEvent = (event) => this.connect(event.detail || {});
        this.handleUpdateEvent = (event) => this.applyBlackboardUpdate(event.detail || {});
        this.handleDisconnectEvent = () => this.cleanup();
        this.handleToolbarToolEvent = (event) => this.setActiveTool(event.detail?.tool);
        this.handleToolbarAddWidgetEvent = (event) => {
            void this.addWidget(event.detail?.type);
        };
        this.handleToolbarImageUploadEvent = (event) => {
            void this.addImageWidgetFromFile(event.detail?.file).catch((error) => {
                console.error('[WebMeetBlackboard] Image upload failed', error);
            });
        };
        this.handleToolbarActionEvent = (event) => {
            if (event.detail?.action === 'delete') void this.deleteSelectedWidget();
            if (event.detail?.action === 'clear') void this.clearBlackboard();
            if (event.detail?.action === 'undo') void this.undo();
            if (event.detail?.action === 'redo') void this.redo();
        };
        this.handleToolbarTextStyleEvent = (event) => {
            void this.setTextWidgetStyle(event.detail || {});
        };
        this.handleToolbarBackgroundEvent = (event) => {
            void this.setBlackboardBackground(event.detail?.background);
        };
        this.handleToolbarThemeEvent = (event) => {
            void this.setBlackboardTheme(event.detail?.themeId);
        };
        this.handleEditorSaveEvent = (event) => this.saveEditorPatch(event);
        this.handlePanelKeydownEvent = (event) => this.handlePanelKeydown(event);
        this.handleDocumentKeydownEvent = (event) => this.handlePanelKeydown(event);
        this.handleBoardPointerDown = (event) => this.handleBoardPointerDownCapture(event);
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
        this.handleLocalRotate = this.handleLocalRotate.bind(this);
        this.finishLocalRotate = this.finishLocalRotate.bind(this);
        this.cancelLocalRotate = this.cancelLocalRotate.bind(this);
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
        this.element.removeEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.handleDocumentKeydownEvent, true);
        }
        this.element.addEventListener('webmeet-blackboard-connect', this.handleConnectEvent);
        this.element.addEventListener('webmeet-blackboard-update', this.handleUpdateEvent);
        this.element.addEventListener('webmeet-blackboard-disconnect', this.handleDisconnectEvent);
        this.element.addEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.handleDocumentKeydownEvent, true);
        }
        if (this.board) {
            this.board.removeEventListener?.('pointerdown', this.handleBoardPointerDown, true);
            this.board.addEventListener?.('pointerdown', this.handleBoardPointerDown, true);
        }
    }

    bindToolbar() {
        this.toolbar?.removeEventListener('blackboard-tool', this.handleToolbarToolEvent);
        this.toolbar?.removeEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.removeEventListener('blackboard-image-upload', this.handleToolbarImageUploadEvent);
        this.toolbar?.removeEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.removeEventListener('blackboard-text-style', this.handleToolbarTextStyleEvent);
        this.toolbar?.removeEventListener('blackboard-background', this.handleToolbarBackgroundEvent);
        this.toolbar?.removeEventListener('blackboard-theme', this.handleToolbarThemeEvent);
        this.toolbar?.addEventListener('blackboard-tool', this.handleToolbarToolEvent);
        this.toolbar?.addEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.addEventListener('blackboard-image-upload', this.handleToolbarImageUploadEvent);
        this.toolbar?.addEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.addEventListener('blackboard-text-style', this.handleToolbarTextStyleEvent);
        this.toolbar?.addEventListener('blackboard-background', this.handleToolbarBackgroundEvent);
        this.toolbar?.addEventListener('blackboard-theme', this.handleToolbarThemeEvent);
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

    handlePanelKeydown(event) {
        if (!this.isDeleteKeyEvent(event)) return;
        if (this.busy || !this.selection) return;
        if (this.isTextEditingTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        void this.deleteSelectedWidget();
    }

    isDeleteKeyEvent(event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return false;
        if (event.key === 'Delete' || event.key === 'Backspace' || event.key === 'Del') return true;
        return event.code === 'Delete' || event.code === 'Backspace' || event.keyCode === 46 || event.keyCode === 8;
    }

    isTextEditingTarget(target) {
        const element = target instanceof Element ? target : null;
        if (!element) return false;
        if (element.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]')) {
            return true;
        }
        return Boolean(this.inlineEditWidgetId);
    }

    afterUnload() {
        this.element.removeEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.handleDocumentKeydownEvent, true);
        }
        if (this.board) {
            this.board.removeEventListener?.('pointerdown', this.handleBoardPointerDown, true);
        }
        this.cleanup();
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
