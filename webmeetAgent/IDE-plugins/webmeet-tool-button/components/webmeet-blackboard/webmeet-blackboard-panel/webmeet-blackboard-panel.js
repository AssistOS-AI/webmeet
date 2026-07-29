import { blackboardActionMethods } from './webmeet-blackboard-actions.js';
import { blackboardGeometryMethods } from './webmeet-blackboard-geometry.js';
import { blackboardGraphicsRenderingMethods } from './webmeet-blackboard-graphics-rendering.js';
import { blackboardInteractionMethods } from './webmeet-blackboard-interactions.js';
import { blackboardGroupMethods } from './webmeet-blackboard-groups.js';
import { blackboardExportMethods } from './webmeet-blackboard-export.js';
import { blackboardRenderingMethods } from './webmeet-blackboard-rendering.js';
import { blackboardAttachmentRenderingMethods } from './webmeet-blackboard-attachment-rendering.js';
import { blackboardCollaborationRenderingMethods } from './webmeet-blackboard-collaboration-rendering.js';
import { blackboardScriptaActionMethods } from './webmeet-blackboard-scripta-actions.js';
import { blackboardScriptaRenderingMethods } from './webmeet-blackboard-scripta-rendering.js';
import { blackboardWorkspaceMethods } from './webmeet-blackboard-workspaces.js';

export class WebMeetBlackboardPanel {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.adapter = null;
        this.blackboard = {widgets: []};
        this.workspace = { revision: 0, activeBoardId: '', boardOrder: [], boards: [] };
        this.boardCache = new Map();
        this.filmstripOpen = false;
        this.workspaceTransitionTimer = null;
        this.workspaceTabActivationTimer = null;
        this.workspaceTabActivationBoardId = '';
        this.workspaceDropState = null;
        this.draggedWorkspaceBoardId = '';
        this.filmstripDragState = null;
        this.blackboardClipboard = null;
        this.selectionContextState = null;
        this.renamingWorkspaceBoardId = '';
        this.widgetNodes = new Map();
        this.selection = '';
        this.selectedWidgetIds = new Set();
        this.selectedGroupId = '';
        this.groupOverlay = null;
        this.groupDragState = null;
        this.groupRotateState = null;
        this.groupResizeState = null;
        this.groupExportMenu = null;
        this.groupExportBusy = false;
        this.marqueeState = null;
        this.activeTool = 'select';
        this.viewport = {x: 0, y: 0, scale: 1};
        this.dragState = null;
        this.resizeState = null;
        this.rotateState = null;
        this.pendingCreateDragState = null;
        this.unsubscribeAdapter = null;
        this.widgetCreateOffset = 0;
        this.pendingWidgetType = '';
        this.busy = false;
        this.inlineEditWidgetId = '';
        this.inlineEditState = null;
        this.inlineEditCommitPromise = null;
        this.pendingRenderAfterInlineEdit = false;
        this.roboOrdinalMode = false;
        this.fullscreenWidgetId = '';
        this.scriptaDraft = null;
        this.pendingScriptaDraft = null;
        this.scriptaDraftTimer = null;
        this.scriptaEditStartPromise = Promise.resolve();
        this.scriptaImageInspector = null;
        this.fileDragDepth = 0;

        this.handleWorkspaceTabDragStart = (event) => blackboardWorkspaceMethods.handleWorkspaceTabDragStart.call(this, event);
        this.handleWorkspaceTabDragOver = (event) => blackboardWorkspaceMethods.handleWorkspaceTabDragOver.call(this, event);
        this.handleWorkspaceTabDrop = (event) => void blackboardWorkspaceMethods.handleWorkspaceTabDrop.call(this, event);
        this.handleWorkspaceTabDragEnd = () => blackboardWorkspaceMethods.handleWorkspaceTabDragEnd.call(this);
        this.handleWorkspaceTitleChangeEvent = (event) => blackboardWorkspaceMethods.handleWorkspaceTitleChange.call(this, event);
        this.handleWorkspaceTitleKeydownEvent = (event) => blackboardWorkspaceMethods.handleWorkspaceTitleKeydown.call(this, event);
        this.handleWorkspaceTitleFocusOutEvent = (event) => blackboardWorkspaceMethods.handleWorkspaceTitleFocusOut.call(this, event);
        this.handleWorkspaceTabDoubleClickEvent = (event) => blackboardWorkspaceMethods.handleWorkspaceTabDoubleClick.call(this, event);
        this.handleFilmstripDragStartEvent = (event) => blackboardWorkspaceMethods.handleFilmstripDragStart.call(this, event);
        this.handleFilmstripDragOverEvent = (event) => blackboardWorkspaceMethods.handleFilmstripDragOver.call(this, event);
        this.handleFilmstripDragLeaveEvent = (event) => blackboardWorkspaceMethods.handleFilmstripDragLeave.call(this, event);
        this.handleFilmstripDropEvent = (event) => void blackboardWorkspaceMethods.handleFilmstripDrop.call(this, event);
        this.handleFilmstripDragEndEvent = () => blackboardWorkspaceMethods.handleFilmstripDragEnd.call(this);
        this.handleBoardContextMenuEvent = (event) => blackboardWorkspaceMethods.handleBlackboardContextMenu.call(this, event);
        this.handleFilmstripContextMenuEvent = (event) => blackboardWorkspaceMethods.handleFilmstripContextMenu.call(this, event);
        this.handleSelectionContextOutsidePointerDownEvent = (event) => blackboardWorkspaceMethods.handleSelectionContextOutsidePointerDown.call(this, event);
        this.handleWorkspaceDropPointerMoveEvent = (event) => blackboardWorkspaceMethods.handleWorkspaceDropPointerMove.call(this, event);
        this.handleWorkspaceDropPointerUpEvent = (event) => void blackboardWorkspaceMethods.finishWorkspaceDrop.call(this, event);
        this.handleWorkspaceDropPointerCancelEvent = () => blackboardWorkspaceMethods.cancelWorkspaceDrop.call(this);
        this.handleBoardFileDragEnterEvent = (event) => this.handleBoardFileDragEnter(event);
        this.handleBoardFileDragOverEvent = (event) => this.handleBoardFileDragOver(event);
        this.handleBoardFileDragLeaveEvent = (event) => this.handleBoardFileDragLeave(event);
        this.handleBoardFileDropEvent = (event) => this.handleBoardFileDrop(event);
        this.handleDocumentPasteEvent = (event) => this.handlePanelPaste(event);

        this.bindPointerHandlers();
        this.handleConnectEvent = (event) => this.connect(event.detail || {});
        this.handleUpdateEvent = (event) => this.applyBlackboardUpdate(event.detail || {});
        this.handleDisconnectEvent = () => this.cleanup();
        this.handleRoboStatusEvent = (event) => {
            const active = event.detail?.active === true;
            if (active === this.roboOrdinalMode) return;
            this.roboOrdinalMode = active;
            this.renderWidgets();
        };
        this.handleToolbarAddWidgetEvent = (event) => {
            this.setPendingWidgetType(event.detail?.type);
        };
        this.handleToolbarImageUploadEvent = (event) => {
            void this.addImageWidgetFromFile(event.detail?.file).catch((error) => {
                console.error('[WebMeetBlackboard] Image upload failed', error);
            });
        };
        this.handleToolbarScriptaDocumentEvent = (event) => {
            void this.handleScriptaToolbarAction(event.detail || {}).catch((error) => {
                console.error('[WebMeetBlackboard] SCRIPTA document dialog failed', error);
                const message = error?.message || 'Could not open the SCRIPTA document dialog.';
                if (typeof globalThis.assistOS?.showToast === 'function') globalThis.assistOS.showToast(message, 'error', 3000);
                else globalThis.alert?.(message);
            });
        };
        this.handleToolbarActionEvent = (event) => {
            if (event.detail?.action === 'delete') {
                if (this.selectedGroupId) void this.deleteSelectedGroup();
                else void this.deleteSelectedWidget();
            }
            if (event.detail?.action === 'clear') void this.clearBlackboard();
            if (event.detail?.action === 'undo') void this.undo();
            if (event.detail?.action === 'redo') void this.redo();
        };
        this.handleToolbarThemeEvent = (event) => {
            void this.setBlackboardTheme(event.detail?.themeId);
        };
        this.handlePanelKeydownEvent = (event) => this.handlePanelKeydown(event);
        this.handleDocumentKeydownEvent = (event) => this.handlePanelKeydown(event);
        this.handleBoardPointerDown = (event) => this.handleBoardPointerDownCapture(event);
        this.handleSelectWidgetEvent = (event) => {
            const widgetId = String(event.detail?.widgetId || '').trim();
            if (!widgetId || !(this.blackboard?.widgets || []).some((widget) => widget?.id === widgetId)) return;
            this.selection = widgetId;
            this.selectedGroupId = '';
            this.selectedWidgetIds.clear();
            this.renderWidgets();
            this.widgetNodes.get(widgetId)?.scrollIntoView?.({block: 'center', inline: 'center'});
        };
        this.handleInsertGroupScriptaEvent = async (event) => {
            const detail = event.detail || {};
            try {
                const groupId = String(detail.groupId || '').trim();
                const members = (this.blackboard?.widgets || []).filter((widget) => String(widget?.groupId || '') === groupId);
                if (!groupId || members.length < 2) throw new Error('The selected Blackboard group no longer exists.');
                this.selectedGroupId = groupId;
                this.selection = '';
                this.selectedWidgetIds.clear();
                this.renderWidgets();
                await this.insertSelectedGroupIntoScripta({
                    background: 'transparent',
                    alt: String(detail.alt || 'Blackboard diagram'),
                    throwOnError: true
                });
                detail.resolve?.();
            } catch (error) {
                detail.reject?.(error);
            }
        };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindHostEvents();
        this.bindToolbar();
        this.connectAdapter();
        this.renderWidgets();
        this.renderWorkspaceTabs();
        this.bindWorkspaceGestures();
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
        this.handlePendingWidgetDrawMove = this.handlePendingWidgetDrawMove.bind(this);
        this.finishPendingWidgetDraw = this.finishPendingWidgetDraw.bind(this);
        this.cancelPendingWidgetDraw = this.cancelPendingWidgetDraw.bind(this);
        this.handleGroupDrag = this.handleGroupDrag.bind(this);
        this.finishGroupDrag = this.finishGroupDrag.bind(this);
        this.cancelGroupDrag = this.cancelGroupDrag.bind(this);
        this.handleGroupRotate = this.handleGroupRotate.bind(this);
        this.finishGroupRotate = this.finishGroupRotate.bind(this);
        this.cancelGroupRotate = this.cancelGroupRotate.bind(this);
        this.handleGroupResize = this.handleGroupResize.bind(this);
        this.finishGroupResize = this.finishGroupResize.bind(this);
        this.cancelGroupResize = this.cancelGroupResize.bind(this);
        this.handleMarqueeSelection = this.handleMarqueeSelection.bind(this);
        this.finishMarqueeSelection = this.finishMarqueeSelection.bind(this);
        this.cancelMarqueeSelection = this.cancelMarqueeSelection.bind(this);
    }

    cacheElements() {
        this.board = this.element.querySelector('[data-role="board"]');
        this.toolbar = this.element.querySelector('webmeet-blackboard-toolbar');
        this.resultsPanel = this.element.querySelector('webmeet-blackboard-results-panel');
        this.workspaceTabs = this.element.querySelector('[data-role="workspace-tabs"]');
        this.workspaceStage = this.element.querySelector('[data-role="workspace-stage"]');
        this.transitionLayer = this.element.querySelector('[data-role="transition-layer"]');
        this.workspaceFilmstrip = this.element.querySelector('[data-role="workspace-filmstrip"]');
        this.workspaceFilmstripTrack = this.element.querySelector('[data-role="workspace-filmstrip-track"]');
        this.selectionContextMenu = this.element.querySelector('[data-role="selection-context-menu"]');
        this.fileDropOverlay = this.element.querySelector('[data-role="file-drop-overlay"]');
    }

    bindHostEvents() {
        this.element.removeEventListener('webmeet-blackboard-connect', this.handleConnectEvent);
        this.element.removeEventListener('webmeet-blackboard-update', this.handleUpdateEvent);
        this.element.removeEventListener('webmeet-blackboard-disconnect', this.handleDisconnectEvent);
        this.element.removeEventListener('webmeet-blackboard-robo-status', this.handleRoboStatusEvent);
        this.element.removeEventListener('webmeet-blackboard-select-widget', this.handleSelectWidgetEvent);
        this.element.removeEventListener('webmeet-blackboard-insert-group-scripta', this.handleInsertGroupScriptaEvent);
        this.element.removeEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.handleDocumentKeydownEvent, true);
            document.removeEventListener('paste', this.handleDocumentPasteEvent, true);
        }
        this.element.addEventListener('webmeet-blackboard-connect', this.handleConnectEvent);
        this.element.addEventListener('webmeet-blackboard-update', this.handleUpdateEvent);
        this.element.addEventListener('webmeet-blackboard-disconnect', this.handleDisconnectEvent);
        this.element.addEventListener('webmeet-blackboard-robo-status', this.handleRoboStatusEvent);
        this.element.addEventListener('webmeet-blackboard-select-widget', this.handleSelectWidgetEvent);
        this.element.addEventListener('webmeet-blackboard-insert-group-scripta', this.handleInsertGroupScriptaEvent);
        this.element.addEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.addEventListener('keydown', this.handleDocumentKeydownEvent, true);
            document.addEventListener('paste', this.handleDocumentPasteEvent, true);
        }
        if (this.board) {
            this.board.removeEventListener?.('pointerdown', this.handleBoardPointerDown, true);
            this.board.removeEventListener?.('contextmenu', this.handleBoardContextMenuEvent);
            this.board.removeEventListener?.('dragenter', this.handleBoardFileDragEnterEvent);
            this.board.removeEventListener?.('dragover', this.handleBoardFileDragOverEvent);
            this.board.removeEventListener?.('dragleave', this.handleBoardFileDragLeaveEvent);
            this.board.removeEventListener?.('drop', this.handleBoardFileDropEvent);
            this.board.addEventListener?.('pointerdown', this.handleBoardPointerDown, true);
            this.board.addEventListener?.('contextmenu', this.handleBoardContextMenuEvent);
            this.board.addEventListener?.('dragenter', this.handleBoardFileDragEnterEvent);
            this.board.addEventListener?.('dragover', this.handleBoardFileDragOverEvent);
            this.board.addEventListener?.('dragleave', this.handleBoardFileDragLeaveEvent);
            this.board.addEventListener?.('drop', this.handleBoardFileDropEvent);
        }
    }

    getTransferredFiles(transfer = null) {
        const itemFiles = Array.from(transfer?.items || [])
            .filter((item) => item?.kind === 'file')
            .map((item) => item.getAsFile?.())
            .filter(Boolean);
        return itemFiles.length ? itemFiles : Array.from(transfer?.files || []).filter(Boolean);
    }

    hasTransferredFiles(transfer = null) {
        return Array.from(transfer?.items || []).some((item) => item?.kind === 'file')
            || Array.from(transfer?.files || []).length > 0
            || Array.from(transfer?.types || []).includes('Files');
    }

    setFileDropActive(active) {
        const isActive = active === true;
        if (this.fileDropOverlay) {
            this.fileDropOverlay.hidden = !isActive;
            this.fileDropOverlay.setAttribute('aria-hidden', isActive ? 'false' : 'true');
        }
    }

    publishTransferredFiles(files, {boardId = '', position = null} = {}) {
        const list = Array.from(files || []).filter(Boolean);
        const targetBoardId = String(boardId || this.workspace?.activeBoardId || '').trim();
        if (!list.length || !targetBoardId) return false;
        this.element.dispatchEvent(new CustomEvent('webmeet-blackboard-attachment-upload', {
            bubbles: true,
            composed: true,
            detail: {files: list, boardId: targetBoardId, position}
        }));
        return true;
    }

    handleBoardFileDragEnter(event) {
        if (!this.hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        this.fileDragDepth += 1;
        this.setFileDropActive(true);
    }

    handleBoardFileDragOver(event) {
        if (!this.hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
        this.setFileDropActive(true);
    }

    handleBoardFileDragLeave(event) {
        if (!this.fileDragDepth) return;
        event.preventDefault();
        this.fileDragDepth = Math.max(0, this.fileDragDepth - 1);
        if (!this.fileDragDepth) this.setFileDropActive(false);
    }

    handleBoardFileDrop(event) {
        if (!this.hasTransferredFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        const files = this.getTransferredFiles(event.dataTransfer);
        const position = this.getBoardPointFromEvent(event);
        this.fileDragDepth = 0;
        this.setFileDropActive(false);
        this.publishTransferredFiles(files, {position});
    }

    handlePanelPaste(event) {
        if (event.defaultPrevented || this.isTextEditingTarget(event.target)) return;
        const insidePanel = event.target === this.element || this.element?.contains?.(event.target);
        if (!insidePanel) return;
        const files = this.getTransferredFiles(event.clipboardData);
        if (!files.length) {
            if (!this.canPasteBlackboardSelection(event.target)) return;
            event.preventDefault();
            event.stopPropagation();
            void this.pasteBlackboardSelection(event.target);
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (this.filmstripOpen) {
            const focused = event.target?.closest?.('.webmeet-blackboard-filmstrip-card')
                || document.activeElement?.closest?.('.webmeet-blackboard-filmstrip-card');
            const preview = focused?.querySelector?.('[data-role="filmstrip-preview"]');
            const position = preview ? {
                x: Number(preview.dataset?.logicalWidth || 1200) / 2,
                y: Number(preview.dataset?.logicalHeight || 800) / 2
            } : null;
            this.publishTransferredFiles(files, {
                boardId: String(focused?.dataset?.boardId || this.workspace?.activeBoardId || ''),
                position
            });
            return;
        }
        const rect = this.board?.getBoundingClientRect?.();
        const position = rect ? this.getBoardPointFromEvent({
            clientX: Number(rect.left || 0) + Number(rect.width || 0) / 2,
            clientY: Number(rect.top || 0) + Number(rect.height || 0) / 2
        }) : null;
        this.publishTransferredFiles(files, {position});
    }

    bindToolbar() {
        this.toolbar?.removeEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.removeEventListener('blackboard-image-upload', this.handleToolbarImageUploadEvent);
        this.toolbar?.removeEventListener('blackboard-scripta-document', this.handleToolbarScriptaDocumentEvent);
        this.toolbar?.removeEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.removeEventListener('blackboard-theme', this.handleToolbarThemeEvent);
        this.toolbar?.addEventListener('blackboard-add-widget', this.handleToolbarAddWidgetEvent);
        this.toolbar?.addEventListener('blackboard-image-upload', this.handleToolbarImageUploadEvent);
        this.toolbar?.addEventListener('blackboard-scripta-document', this.handleToolbarScriptaDocumentEvent);
        this.toolbar?.addEventListener('blackboard-action', this.handleToolbarActionEvent);
        this.toolbar?.addEventListener('blackboard-theme', this.handleToolbarThemeEvent);
    }

    connect({adapter, blackboard, workspace} = {}) {
        if (adapter && adapter !== this.adapter) {
            this.unsubscribeAdapter?.();
            this.unsubscribeAdapter = null;
            this.adapter = adapter;
        }
        if (workspace) this.applyWorkspace(workspace, { animate: false });
        else this.applyBlackboard(blackboard);
        this.connectAdapter();
        return this;
    }

    connectAdapter() {
        if (!this.adapter || this.unsubscribeAdapter) return;
        this.unsubscribeAdapter = this.adapter.subscribe((payload) => {
            if (payload.kind === 'workspace') {
                this.applyWorkspace(payload.object);
            } else if (payload.kind === 'blackboard') {
                this.applyBlackboard(payload.object || {widgets: []});
            } else if (payload.kind === 'blackboard-state') {
                this.setBlackboardState(payload.object || {widgets: []});
            } else if (payload.kind === 'widget') {
                this.applyWidgetObject(payload.object);
            } else if (payload.kind === 'scripta-presentation') {
                this.applyScriptaPresentation(payload.presentation);
            }
        });
    }

    applyBlackboardUpdate(detail = {}) {
        if (detail?.workspace) {
            this.applyWorkspace(detail.workspace);
            return;
        }
        if (detail?.scriptaPresentation) {
            this.applyScriptaPresentation(detail.scriptaPresentation);
            return;
        }
        if (detail?.blackboard) {
            this.applyBlackboard(detail.blackboard);
            return;
        }
        if (detail?.widget) {
            this.applyWidgetObject(detail.widget);
            return;
        }
        if (detail?.object && !detail.object.id && (Array.isArray(detail.object.widgets) || detail.object.metadata)) {
            this.applyBlackboard(detail.object);
            return;
        }
        if (detail?.object?.id) {
            this.applyWidgetObject(detail.object);
        }
    }

    applyBlackboard(blackboard) {
        this.setBlackboardState(blackboard);
        this.renderWidgets();
    }

    setBlackboardState(blackboard) {
        if (!blackboard) return;
        this.blackboard = blackboard;
        this.selection = String(blackboard.interactionContext?.focusedWidgetId || '').trim();
        this.selectedWidgetIds.clear();
        const focused = (blackboard.widgets || []).find((widget) => String(widget.id) === this.selection);
        this.selectedGroupId = String(focused?.groupId || '');
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

    handlePanelKeydown(event) {
        if (event.defaultPrevented) return;
        if (event.key === 'Escape' && this.selectionContextState) {
            event.preventDefault();
            event.stopPropagation();
            this.closeSelectionContextMenu();
            return;
        }
        const focusedTab = event.target?.closest?.('[role="tab"]');
        if (focusedTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
            const tabs = [...this.workspaceTabs?.querySelectorAll?.('[role="tab"]') || []];
            const currentIndex = tabs.indexOf(focusedTab);
            if (currentIndex >= 0 && tabs.length) {
                event.preventDefault();
                const nextIndex = event.key === 'Home' ? 0
                    : event.key === 'End' ? tabs.length - 1
                        : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
                tabs[nextIndex]?.focus?.();
                void this.activateWorkspaceBoard(tabs[nextIndex]);
            }
            return;
        }
        if (event.key === 'Escape' && this.filmstripOpen) {
            event.preventDefault();
            this.setFilmstripOpen(false);
            return;
        }
        const clipboardKey = String(event.key || '').toLowerCase();
        if ((event.ctrlKey || event.metaKey) && !event.altKey && ['c', 'x'].includes(clipboardKey)
            && !this.isTextEditingTarget(event.target)) {
            const insidePanel = event.target === this.element || this.element?.contains?.(event.target);
            if (!insidePanel) return;
            const handled = clipboardKey === 'c'
                ? this.copyBlackboardSelection(event.target, {mode: 'copy'})
                : this.copyBlackboardSelection(event.target, {mode: 'cut'});
            if (!handled) return;
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && (event.key === 'PageUp' || event.key === 'PageDown') && !this.isTextEditingTarget(event.target)) {
            const order = this.workspace?.boardOrder || [];
            const index = order.indexOf(this.workspace?.activeBoardId);
            if (order.length > 1 && index >= 0) {
                event.preventDefault();
                const delta = event.key === 'PageDown' ? 1 : -1;
                const boardId = order[(index + delta + order.length) % order.length];
                void this.activateWorkspaceBoard({ dataset: { boardId } });
            }
            return;
        }
        if (event.key === 'Escape' && this.groupExportMenu) {
            event.preventDefault();
            event.stopPropagation();
            this.closeGroupExportMenu();
            return;
        }
        if (event.key === 'Escape' && this.fullscreenWidgetId) {
            event.preventDefault();
            event.stopPropagation();
            this.fullscreenWidgetId = '';
            this.renderWidgets();
            return;
        }
        if (!this.isDeleteKeyEvent(event)) return;
        if (this.busy || !this.selection) return;
        if (this.isTextEditingTarget(event.target)) return;
        event.preventDefault();
        event.stopPropagation();
        if (this.selectedGroupId) void this.deleteSelectedGroup();
        else void this.deleteSelectedWidget();
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
        this.element.removeEventListener('webmeet-blackboard-select-widget', this.handleSelectWidgetEvent);
        this.element.removeEventListener('webmeet-blackboard-insert-group-scripta', this.handleInsertGroupScriptaEvent);
        this.element.removeEventListener('keydown', this.handlePanelKeydownEvent);
        if (typeof document !== 'undefined') {
            document.removeEventListener('keydown', this.handleDocumentKeydownEvent, true);
            document.removeEventListener('paste', this.handleDocumentPasteEvent, true);
        }
        if (this.board) {
            this.board.removeEventListener?.('pointerdown', this.handleBoardPointerDown, true);
            this.board.removeEventListener?.('contextmenu', this.handleBoardContextMenuEvent);
            this.board.removeEventListener?.('dragenter', this.handleBoardFileDragEnterEvent);
            this.board.removeEventListener?.('dragover', this.handleBoardFileDragOverEvent);
            this.board.removeEventListener?.('dragleave', this.handleBoardFileDragLeaveEvent);
            this.board.removeEventListener?.('drop', this.handleBoardFileDropEvent);
        }
        if (this.workspaceTabs) {
            this.workspaceTabs.removeEventListener('dragstart', this.handleWorkspaceTabDragStart);
            this.workspaceTabs.removeEventListener('dragover', this.handleWorkspaceTabDragOver);
            this.workspaceTabs.removeEventListener('drop', this.handleWorkspaceTabDrop);
            this.workspaceTabs.removeEventListener('dragend', this.handleWorkspaceTabDragEnd);
            this.workspaceTabs.removeEventListener('change', this.handleWorkspaceTitleChangeEvent);
            this.workspaceTabs.removeEventListener('keydown', this.handleWorkspaceTitleKeydownEvent);
            this.workspaceTabs.removeEventListener('focusout', this.handleWorkspaceTitleFocusOutEvent);
            this.workspaceTabs.removeEventListener('dblclick', this.handleWorkspaceTabDoubleClickEvent);
        }
        if (this.workspaceFilmstripTrack) {
            this.workspaceFilmstripTrack.removeEventListener('dragstart', this.handleFilmstripDragStartEvent);
            this.workspaceFilmstripTrack.removeEventListener('dragover', this.handleFilmstripDragOverEvent);
            this.workspaceFilmstripTrack.removeEventListener('dragleave', this.handleFilmstripDragLeaveEvent);
            this.workspaceFilmstripTrack.removeEventListener('drop', this.handleFilmstripDropEvent);
            this.workspaceFilmstripTrack.removeEventListener('dragend', this.handleFilmstripDragEndEvent);
            this.workspaceFilmstripTrack.removeEventListener('contextmenu', this.handleFilmstripContextMenuEvent);
        }
        this.closeSelectionContextMenu?.();
        this.detachWorkspaceDropListeners?.();
        this.workspaceDropState?.ghost?.remove?.();
        this.workspaceDropState = null;
        this.cancelPendingWidgetDraw?.();
        this.cancelGroupDrag?.();
        this.cancelGroupRotate?.();
        this.cancelGroupResize?.();
        this.closeGroupExportMenu?.();
        this.cancelMarqueeSelection?.();
        this.cleanup();
    }

    cleanup() {
        this.cancelWorkspaceDrop?.();
        if (this.scriptaDraftTimer) clearTimeout(this.scriptaDraftTimer);
        this.scriptaDraftTimer = null;
        this.pendingScriptaDraft = null;
        globalThis.clearTimeout(this.workspaceTransitionTimer);
        this.clearWorkspaceTabActivation?.();
        this.unsubscribeAdapter?.();
        this.unsubscribeAdapter = null;
    }
}

Object.assign(
    WebMeetBlackboardPanel.prototype,
    blackboardGeometryMethods,
    blackboardGraphicsRenderingMethods,
    blackboardAttachmentRenderingMethods,
    blackboardRenderingMethods,
    blackboardCollaborationRenderingMethods,
    blackboardScriptaActionMethods,
    blackboardScriptaRenderingMethods,
    blackboardWorkspaceMethods,
    blackboardExportMethods,
    blackboardGroupMethods,
    blackboardInteractionMethods,
    blackboardActionMethods
);
