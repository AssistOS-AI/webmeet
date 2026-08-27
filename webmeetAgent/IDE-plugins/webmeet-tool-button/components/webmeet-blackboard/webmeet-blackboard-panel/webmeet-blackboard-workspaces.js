function templateContent(element, name) {
    return element?.querySelector?.(`template[data-template="${name}"]`)?.content || null;
}

function boardIndex(workspace, boardId) {
    return Array.isArray(workspace?.boardOrder) ? workspace.boardOrder.indexOf(String(boardId || '')) : -1;
}

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function formatFileSize(value) {
    const bytes = Math.max(0, Number(value || 0));
    if (bytes < 1024) return `${bytes} B`;
    const megabytes = bytes / (1024 * 1024);
    if (megabytes >= 1) return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
}

export function getFilmstripSelectionBounds(widgets = [], widgetIds = []) {
    const selectedIds = new Set([...widgetIds].map((id) => String(id || '').trim()).filter(Boolean));
    const geometries = widgets
        .filter((widget) => !selectedIds.size || selectedIds.has(String(widget?.id || '')))
        .map((widget) => widget?.properties?.geometry)
        .filter(Boolean);
    if (!geometries.length) return null;
    const x = Math.min(...geometries.map((geometry) => Number(geometry.x || 0)));
    const y = Math.min(...geometries.map((geometry) => Number(geometry.y || 0)));
    const right = Math.max(...geometries.map((geometry) => Number(geometry.x || 0) + Number(geometry.width || 1)));
    const bottom = Math.max(...geometries.map((geometry) => Number(geometry.y || 0) + Number(geometry.height || 1)));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y)};
}

export function getFilmstripLogicalPoint(clientX, clientY, previewRect, logicalWidth, logicalHeight) {
    const width = Math.max(1, Number(previewRect?.width || 0));
    const height = Math.max(1, Number(previewRect?.height || 0));
    return {
        x: clamp((Number(clientX || 0) - Number(previewRect?.left || 0)) / width, 0, 1) * logicalWidth,
        y: clamp((Number(clientY || 0) - Number(previewRect?.top || 0)) / height, 0, 1) * logicalHeight,
    };
}

export function resolveFilmstripDropPlacement({
    clientX = 0,
    clientY = 0,
    previewRect = {},
    logicalWidth = 1200,
    logicalHeight = 800,
    sourceBounds = {},
    grabOffset = {},
} = {}) {
    const targetWidth = Math.max(1, Number(logicalWidth || 1200));
    const targetHeight = Math.max(1, Number(logicalHeight || 800));
    const point = getFilmstripLogicalPoint(clientX, clientY, previewRect, targetWidth, targetHeight);
    const width = Math.max(1, Number(sourceBounds.width || 1));
    const height = Math.max(1, Number(sourceBounds.height || 1));
    return {
        x: Math.round(clamp(point.x - Number(grabOffset.x || 0), 0, Math.max(0, targetWidth - width)) * 1000) / 1000,
        y: Math.round(clamp(point.y - Number(grabOffset.y || 0), 0, Math.max(0, targetHeight - height)) * 1000) / 1000,
    };
}

export function resolveClipboardPastePlacement(sourceBounds = {}, targetBoard = {}) {
    const geometries = (Array.isArray(targetBoard?.widgets) ? targetBoard.widgets : [])
        .map((widget) => widget?.properties?.geometry)
        .filter(Boolean);
    const targetWidth = Math.max(1200, ...geometries.map((geometry) => Number(geometry.x || 0) + Number(geometry.width || 1)));
    const targetHeight = Math.max(800, ...geometries.map((geometry) => Number(geometry.y || 0) + Number(geometry.height || 1)));
    const width = Math.max(1, Number(sourceBounds.width || 1));
    const height = Math.max(1, Number(sourceBounds.height || 1));
    const offset = 24;
    return {
        x: clamp(Number(sourceBounds.x || 0) + offset, 0, Math.max(0, targetWidth - width)),
        y: clamp(Number(sourceBounds.y || 0) + offset, 0, Math.max(0, targetHeight - height)),
    };
}

export function resolveWorkspaceDropPlacement(point = {}, sourceBounds = {}, grabOffset = {}, targetBoard = {}) {
    const geometries = (Array.isArray(targetBoard?.widgets) ? targetBoard.widgets : [])
        .map((widget) => widget?.properties?.geometry)
        .filter(Boolean);
    const targetWidth = Math.max(1200, ...geometries.map((geometry) => Number(geometry.x || 0) + Number(geometry.width || 1)));
    const targetHeight = Math.max(800, ...geometries.map((geometry) => Number(geometry.y || 0) + Number(geometry.height || 1)));
    const width = Math.max(1, Number(sourceBounds.width || 1));
    const height = Math.max(1, Number(sourceBounds.height || 1));
    return {
        x: Math.round(clamp(Number(point.x || 0) - Number(grabOffset.x || 0), 0, Math.max(0, targetWidth - width)) * 1000) / 1000,
        y: Math.round(clamp(Number(point.y || 0) - Number(grabOffset.y || 0), 0, Math.max(0, targetHeight - height)) * 1000) / 1000,
    };
}

function text(value = '') {
    return String(value ?? '').trim();
}

function filmstripBounds(widgets = []) {
    const geometries = widgets.map((widget) => widget?.properties?.geometry).filter(Boolean);
    if (!geometries.length) return null;
    const x = Math.min(...geometries.map((geometry) => Number(geometry.x || 0)));
    const y = Math.min(...geometries.map((geometry) => Number(geometry.y || 0)));
    const right = Math.max(...geometries.map((geometry) => Number(geometry.x || 0) + Number(geometry.width || 1)));
    const bottom = Math.max(...geometries.map((geometry) => Number(geometry.y || 0) + Number(geometry.height || 1)));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y), rotation: 0};
}

function filmstripGroupGeometryMembers(widgets = []) {
    return widgets.filter((widget) => !widget.properties?.connection);
}

function filmstripAnchorPoint(bounds, anchor = 'center') {
    const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    const point = {
        left: {x: bounds.x, y: center.y},
        right: {x: bounds.x + bounds.width, y: center.y},
        top: {x: center.x, y: bounds.y},
        bottom: {x: center.x, y: bounds.y + bounds.height},
    }[String(anchor || '')] || center;
    const radians = Number(bounds.rotation || 0) * Math.PI / 180;
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {
        x: center.x + dx * Math.cos(radians) - dy * Math.sin(radians),
        y: center.y + dx * Math.sin(radians) + dy * Math.cos(radians),
    };
}

function projectFilmstripConnection(widget, widgets = []) {
    const connection = widget?.properties?.connection;
    if (widget?.type !== 'line' || !connection) return widget;
    const endpointPoint = (endpoint) => {
        if (!endpoint) return null;
        if (endpoint.widgetId) {
            const target = widgets.find((entry) => String(entry.id || '') === String(endpoint.widgetId));
            if (!target || target.type === 'line') return null;
            const geometry = target.properties?.geometry || {};
            return filmstripAnchorPoint({
                x: Number(geometry.x || 0), y: Number(geometry.y || 0),
                width: Math.max(1, Number(geometry.width || 1)), height: Math.max(1, Number(geometry.height || 1)),
                rotation: Number(target.properties?.rotation ?? geometry.rotation ?? 0),
            }, endpoint.anchor);
        }
        const members = filmstripGroupGeometryMembers(
            widgets.filter((entry) => String(entry.groupId || '') === String(endpoint.groupId || '')),
        );
        const bounds = filmstripBounds(members);
        return bounds ? filmstripAnchorPoint(bounds, endpoint.anchor) : null;
    };
    const geometry = widget.properties?.geometry || {};
    const line = widget.properties?.line || {};
    const originX = Number(geometry.x || 0);
    const originY = Number(geometry.y || 0);
    const from = endpointPoint(connection.from) || {x: originX + Number(line.x1 ?? 0), y: originY + Number(line.y1 ?? Number(geometry.height || 1) / 2)};
    const to = endpointPoint(connection.to) || {x: originX + Number(line.x2 ?? Number(geometry.width || 1)), y: originY + Number(line.y2 ?? Number(geometry.height || 1) / 2)};
    const x = Math.min(from.x, to.x) - 0.5;
    const y = Math.min(from.y, to.y) - 0.5;
    return {...widget, properties: {...widget.properties,
        geometry: {...geometry, x, y, width: Math.max(1, Math.abs(to.x - from.x) + 1), height: Math.max(1, Math.abs(to.y - from.y) + 1), rotation: 0},
        rotation: 0,
        line: {...line, x1: from.x - x, y1: from.y - y, x2: to.x - x, y2: to.y - y},
    }};
}

function firstParagraphText(chapter = {}) {
    const paragraph = Array.isArray(chapter?.paragraphs) ? chapter.paragraphs[0] : null;
    if (!paragraph) return '';
    if (text(paragraph.text)) return text(paragraph.text);
    const variants = Array.isArray(paragraph.variants) ? paragraph.variants : [];
    return text(variants.find((variant) => variant?.selected)?.text || variants[0]?.text || '');
}

export function getFilmstripWidgetView(widget = {}) {
    const properties = widget?.properties || {};
    const type = text(widget?.type) || 'widget';
    const style = properties.style || {};
    const view = {
        type,
        kicker: '',
        title: '',
        body: '',
        items: [],
        imageUrl: '',
        imageAlt: '',
        shapeKind: 'rectangle',
        fill: text(style.fill),
        stroke: text(style.stroke),
        textColor: text(style.textColor),
    };
    if (type === 'shape') {
        view.shapeKind = ['rectangle', 'rounded', 'ellipse', 'diamond', 'triangle'].includes(text(properties.shapeKind))
            ? text(properties.shapeKind)
            : 'rectangle';
        view.title = text(properties.label);
    } else if (type === 'line') {
        view.title = text(properties.label);
    } else if (type === 'image') {
        const source = properties.source || {};
        view.imageUrl = text(source.url || source.downloadUrl || properties.src);
        view.imageAlt = text(properties.alt || source.name) || 'Image';
    } else if (type === 'file') {
        const source = properties.source || {};
        view.kicker = text(source.extension).toUpperCase() || 'FILE';
        view.title = text(source.name) || 'File';
        view.body = `${text(source.mimeType) || 'application/octet-stream'} · ${formatFileSize(source.size)}`;
    } else if (type === 'text') {
        view.body = text(properties.text);
    } else if (type === 'card') {
        view.title = text(properties.title);
        view.body = text(properties.text || properties.label);
    } else if (type === 'poll') {
        const questions = Array.isArray(properties.questions) ? properties.questions : [];
        view.kicker = `${questions.length} question${questions.length === 1 ? '' : 's'}`;
        view.title = text(properties.description) || 'Poll';
        view.items = questions.slice(0, 3).map((question) => text(question?.prompt)).filter(Boolean);
    } else if (type === 'bullets') {
        const items = Array.isArray(properties.items) ? properties.items : [];
        view.kicker = text(properties.meetingDateTime || widget.createdAt);
        view.title = text(properties.title) || 'Meeting Bullets';
        view.items = items.slice(0, 4).map((item) => text(item?.text)).filter(Boolean);
    } else if (type === 'scripta-document') {
        const chapters = Array.isArray(properties.chapters) ? properties.chapters : [];
        view.kicker = `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`;
        view.title = text(properties.documentTitle) || 'SCRIPTA Document';
        view.items = chapters.slice(0, 3).map((chapter) => (
            text(chapter?.chapterTitle) || firstParagraphText(chapter)
        )).filter(Boolean);
    } else {
        view.kicker = type;
        view.title = text(properties.title || properties.label);
        view.body = text(properties.text || properties.description);
    }
    return view;
}

export function resolveFilmstripTransferWidgetIds(board = {}, widgetId = '', selectedWidgetIds = []) {
    const widgets = Array.isArray(board?.widgets) ? board.widgets : [];
    const id = String(widgetId || '').trim();
    const widget = widgets.find((entry) => String(entry?.id || '') === id);
    if (!widget) return [];
    const selected = new Set([...selectedWidgetIds].map((entry) => String(entry || '').trim()).filter(Boolean));
    const resolved = selected.size > 1 && selected.has(id) ? selected : new Set([id]);
    let changed = true;
    while (changed) {
        const beforeSize = resolved.size;
        const groupIds = new Set(widgets
            .filter((entry) => resolved.has(String(entry?.id || '')))
            .map((entry) => String(entry?.groupId || '').trim())
            .filter(Boolean));
        for (const entry of widgets) {
            const entryId = String(entry?.id || '').trim();
            if (groupIds.has(String(entry?.groupId || '').trim())) resolved.add(entryId);
            const fromId = String(entry?.properties?.connection?.from?.widgetId || '');
            const toId = String(entry?.properties?.connection?.to?.widgetId || '');
            if (entry?.type !== 'line' || !fromId || !toId) continue;
            if (resolved.has(entryId)) resolved.add(fromId).add(toId);
            if (resolved.has(fromId) && resolved.has(toId)) resolved.add(entryId);
        }
        changed = resolved.size !== beforeSize;
    }
    return widgets.map((entry) => String(entry?.id || '').trim()).filter((entryId) => resolved.has(entryId));
}

export function getFilmstripGroupPreviews(widgets = []) {
    const groups = new Map();
    for (const widget of widgets) {
        const groupId = String(widget?.groupId || '').trim();
        if (!groupId) continue;
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(widget);
    }
    const previews = [];
    for (const [groupId, members] of groups) {
        if (members.length < 2) continue;
        const bounds = getFilmstripSelectionBounds(filmstripGroupGeometryMembers(members));
        if (!bounds) continue;
        previews.push({
            groupId,
            representativeId: String(members.at(-1)?.id || ''),
            memberCount: members.length,
            bounds,
        });
    }
    return previews;
}

export const blackboardWorkspaceMethods = {
    resolveContextSelection(board, widgetId = '') {
        const id = String(widgetId || '').trim();
        if (!id) return [];
        const selected = this.selectedWidgetIds?.size > 1 && this.selectedWidgetIds.has(id)
            ? this.selectedWidgetIds
            : [];
        return resolveFilmstripTransferWidgetIds(board, id, selected);
    },

    handleBlackboardContextMenu(event) {
        if (!this.board || event.target?.closest?.('[data-role="selection-context-menu"]')) return;
        const widgetNode = event.target?.closest?.('.webmeet-blackboard-widget');
        const groupNode = event.target?.closest?.('.webmeet-blackboard-group-overlay, .webmeet-blackboard-group-hit-area');
        let widgetId = String(widgetNode?.dataset?.widgetId || '').trim();
        const groupId = String(groupNode?.dataset?.groupId || '').trim();
        if (groupId) {
            const members = this.getGroupMembers(groupId);
            widgetId = String(members.at(-1)?.id || '');
            if (members.length > 1) this.selectGroup(groupId, widgetId);
        } else if (widgetId) {
            const widget = this.getWidgetById(widgetId);
            const preservesMultiSelection = this.selectedWidgetIds?.size > 1 && this.selectedWidgetIds.has(widgetId);
            if (!preservesMultiSelection && widget?.groupId) {
                this.selectGroup(widget.groupId, widget.id);
            } else if (!preservesMultiSelection) {
                this.clearGroupSelection();
                this.selection = widgetId;
                this.renderWidgets();
            }
        }
        const widgetIds = widgetId ? this.resolveContextSelection(this.blackboard, widgetId) : [];
        const placement = this.getBoardPointFromEvent?.(event);
        const selectedWidgets = (this.blackboard?.widgets || []).filter((widget) => widgetIds.includes(String(widget?.id || '')));
        const canCopy = widgetIds.length > 0 && !selectedWidgets.some((widget) => widget.type === 'scripta-document');
        const canCut = widgetIds.length > 0 && !selectedWidgets.some((widget) => this.canMoveWidget?.(widget) === false);
        const canPaste = Boolean(this.blackboardClipboard && placement);
        if (!canCopy && !canCut && !canPaste) return;
        event.preventDefault();
        event.stopPropagation();
        this.openSelectionContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            sourceBoardId: String(this.workspace?.activeBoardId || ''),
            sourceBoard: this.blackboard,
            widgetIds,
            targetBoardId: String(this.workspace?.activeBoardId || ''),
            placement,
            canCopy,
            canCut,
            canPaste,
        });
    },

    handleFilmstripContextMenu(event) {
        const card = event.target?.closest?.('.webmeet-blackboard-filmstrip-card');
        if (!card) return;
        const boardId = String(card.dataset?.boardId || '').trim();
        const board = this.boardCache.get(boardId);
        const node = event.target?.closest?.('[data-role="filmstrip-widget"]');
        const widgetId = String(node?.dataset?.widgetId || '').trim();
        const widgetIds = node ? resolveFilmstripTransferWidgetIds(board, widgetId) : [];
        const preview = event.target?.closest?.('[data-role="filmstrip-preview"]');
        const previewRect = preview?.getBoundingClientRect?.();
        const placement = previewRect ? getFilmstripLogicalPoint(
            event.clientX,
            event.clientY,
            previewRect,
            Number(preview.dataset?.logicalWidth || 1200),
            Number(preview.dataset?.logicalHeight || 800),
        ) : null;
        const selectedWidgets = (board?.widgets || []).filter((widget) => widgetIds.includes(String(widget?.id || '')));
        const canCopy = widgetIds.length > 0 && !selectedWidgets.some((widget) => widget.type === 'scripta-document');
        const canCut = widgetIds.length > 0 && !selectedWidgets.some((widget) => this.canMoveWidget?.(widget) === false);
        const canPaste = Boolean(this.blackboardClipboard && placement);
        if (!canCopy && !canCut && !canPaste) return;
        event.preventDefault();
        event.stopPropagation();
        this.openSelectionContextMenu({
            clientX: event.clientX,
            clientY: event.clientY,
            sourceBoardId: boardId,
            sourceBoard: board,
            widgetIds,
            targetBoardId: boardId,
            placement,
            canCopy,
            canCut,
            canPaste,
        });
    },

    openSelectionContextMenu(state = {}) {
        if (!this.selectionContextMenu) return;
        this.closeSelectionContextMenu();
        this.selectionContextState = state;
        const copy = this.selectionContextMenu.querySelector('[data-role="selection-context-copy"]');
        const cut = this.selectionContextMenu.querySelector('[data-role="selection-context-cut"]');
        const paste = this.selectionContextMenu.querySelector('[data-role="selection-context-paste"]');
        const separator = this.selectionContextMenu.querySelector('[data-role="selection-context-separator"]');
        copy.hidden = state.canCopy !== true;
        cut.hidden = state.canCut !== true;
        paste.hidden = state.canPaste !== true;
        separator.hidden = !(state.canPaste && (state.canCopy || state.canCut));
        this.selectionContextMenu.hidden = false;
        const width = Math.max(168, Number(this.selectionContextMenu.offsetWidth || 0));
        const height = Math.max(44, Number(this.selectionContextMenu.offsetHeight || 0));
        const viewportWidth = Number(globalThis.innerWidth || 1920);
        const viewportHeight = Number(globalThis.innerHeight || 1080);
        this.selectionContextMenu.style.left = `${Math.max(8, Math.min(Number(state.clientX || 0), viewportWidth - width - 8))}px`;
        this.selectionContextMenu.style.top = `${Math.max(8, Math.min(Number(state.clientY || 0), viewportHeight - height - 8))}px`;
        if (typeof document !== 'undefined') {
            document.addEventListener('pointerdown', this.handleSelectionContextOutsidePointerDownEvent, true);
        }
        [...this.selectionContextMenu.querySelectorAll('[role="menuitem"]')].find((button) => !button.hidden)?.focus?.();
    },

    closeSelectionContextMenu() {
        if (typeof document !== 'undefined') {
            document.removeEventListener('pointerdown', this.handleSelectionContextOutsidePointerDownEvent, true);
        }
        if (this.selectionContextMenu) this.selectionContextMenu.hidden = true;
        this.selectionContextState = null;
    },

    handleSelectionContextOutsidePointerDown(event) {
        if (this.selectionContextMenu?.contains?.(event.target)) return;
        this.closeSelectionContextMenu();
    },

    copyContextSelection() {
        const state = this.selectionContextState;
        if (!state?.widgetIds?.length) return;
        this.setBlackboardClipboard({
            sourceBoardId: state.sourceBoardId,
            board: state.sourceBoard,
            widgetIds: state.widgetIds,
            mode: 'copy',
        });
        this.closeSelectionContextMenu();
    },

    cutContextSelection() {
        const state = this.selectionContextState;
        if (!state?.widgetIds?.length) return;
        this.setBlackboardClipboard({
            sourceBoardId: state.sourceBoardId,
            board: state.sourceBoard,
            widgetIds: state.widgetIds,
            mode: 'cut',
        });
        this.closeSelectionContextMenu();
    },

    async pasteContextSelectionHere() {
        const state = this.selectionContextState;
        if (!state?.targetBoardId || !state?.placement) return;
        const targetBoardId = state.targetBoardId;
        const placement = state.placement;
        this.closeSelectionContextMenu();
        await this.pasteBlackboardClipboardAt({targetBoardId, placement});
    },

    copyBlackboardSelection(target, {mode = 'copy'} = {}) {
        let sourceBoardId = String(this.workspace?.activeBoardId || '');
        let board = this.blackboard;
        let widgetIds = [];
        if (this.filmstripOpen) {
            const node = target?.closest?.('[data-role="filmstrip-widget"]');
            sourceBoardId = String(node?.dataset?.boardId || '').trim();
            board = this.boardCache.get(sourceBoardId);
            widgetIds = resolveFilmstripTransferWidgetIds(board, node?.dataset?.widgetId);
            if (!node || !sourceBoardId || !widgetIds.length) return false;
        } else {
            const representativeId = String(this.selection || [...this.selectedWidgetIds || []][0] || '').trim();
            widgetIds = resolveFilmstripTransferWidgetIds(board, representativeId, this.selectedWidgetIds);
            if (!sourceBoardId || !widgetIds.length) return false;
        }
        return this.setBlackboardClipboard({sourceBoardId, board, widgetIds, mode});
    },

    setBlackboardClipboard({sourceBoardId = '', board = null, widgetIds = [], mode = 'copy'} = {}) {
        const normalizedMode = mode === 'cut' ? 'cut' : 'copy';
        const selectedWidgets = (board?.widgets || []).filter((widget) => widgetIds.includes(String(widget?.id || '')));
        if (!selectedWidgets.length) return false;
        if (normalizedMode === 'copy' && selectedWidgets.some((widget) => widget.type === 'scripta-document')) return false;
        if (normalizedMode === 'cut' && selectedWidgets.some((widget) => this.canMoveWidget?.(widget) === false)) return false;
        const sourceBounds = getFilmstripSelectionBounds(selectedWidgets, widgetIds);
        if (!sourceBounds) return false;
        this.blackboardClipboard = {
            sourceBoardId: String(sourceBoardId || '').trim(),
            widgetIds: [...widgetIds],
            sourceBounds,
            mode: normalizedMode,
        };
        if (this.filmstripOpen) this.projectFilmstripClipboardState();
        return true;
    },

    projectFilmstripClipboardState() {
        const clipboard = this.blackboardClipboard;
        for (const node of this.workspaceFilmstripTrack?.querySelectorAll?.('[data-role="filmstrip-widget"]') || []) {
            const isGroupMember = node.classList.contains('is-group-member');
            const selectedForClipboard = !isGroupMember
                && String(clipboard?.sourceBoardId || '') === String(node.dataset?.boardId || '')
                && clipboard?.widgetIds?.includes(String(node.dataset?.widgetId || ''));
            node.classList.toggle('is-copied', selectedForClipboard && clipboard?.mode !== 'cut');
            node.classList.toggle('is-cut', selectedForClipboard && clipboard?.mode === 'cut');
        }
    },

    canPasteBlackboardSelection(target) {
        if (!this.blackboardClipboard) return false;
        if (!this.filmstripOpen) return Boolean(this.workspace?.activeBoardId);
        return Boolean(target?.closest?.('.webmeet-blackboard-filmstrip-card')?.dataset?.boardId);
    },

    async pasteBlackboardSelection(target) {
        if (!this.canPasteBlackboardSelection(target) || this.busy) return;
        const clipboard = this.blackboardClipboard;
        const targetBoardId = this.filmstripOpen
            ? String(target.closest('.webmeet-blackboard-filmstrip-card')?.dataset?.boardId || '').trim()
            : String(this.workspace?.activeBoardId || '').trim();
        const targetBoard = this.boardCache.get(targetBoardId)
            || (targetBoardId === String(this.blackboard?.boardId || '') ? this.blackboard : null)
            || {widgets: []};
        const placement = resolveClipboardPastePlacement(clipboard.sourceBounds, targetBoard);
        await this.pasteBlackboardClipboardAt({targetBoardId, placement});
    },

    async pasteBlackboardClipboardAt({targetBoardId = '', placement = null} = {}) {
        const clipboard = this.blackboardClipboard;
        const destinationBoardId = String(targetBoardId || '').trim();
        if (!clipboard || !destinationBoardId || this.busy) return false;
        const action = clipboard.mode === 'cut' ? 'board-transfer' : 'board-copy';
        this.busy = true;
        this.updateToolbarState?.();
        try {
            this.boardCache.delete(clipboard.sourceBoardId);
            this.boardCache.delete(destinationBoardId);
            await this.adapter.sendWorkspaceAction(action, {
                boardId: clipboard.sourceBoardId,
                targetBoardId: destinationBoardId,
                widgetIds: clipboard.widgetIds,
                placement,
            });
            this.blackboardClipboard = null;
            if (this.filmstripOpen) {
                await this.loadWorkspaceFilmstrip();
                const targetCard = [...this.workspaceFilmstripTrack?.querySelectorAll?.('.webmeet-blackboard-filmstrip-card') || []]
                    .find((card) => String(card.dataset?.boardId || '') === destinationBoardId);
                targetCard?.focus?.();
            }
            return true;
        } catch (error) {
            const message = error?.message || 'Could not paste the Blackboard selection.';
            if (typeof globalThis.assistOS?.showToast === 'function') globalThis.assistOS.showToast(message, 'error', 3000);
            else console.error('[WebMeetBlackboard] Paste failed', error);
            return false;
        } finally {
            this.busy = false;
            this.updateToolbarState?.();
        }
    },

    renderFilmstripWidget(widget, { boardId = '', draggable = true } = {}) {
        const source = templateContent(this.element, 'workspace-filmstrip-widget');
        const node = source?.cloneNode(true)?.querySelector?.('.webmeet-blackboard-filmstrip-widget');
        if (!node) return null;
        const view = getFilmstripWidgetView(widget);
        node.dataset.boardId = String(boardId || '');
        node.dataset.widgetId = String(widget?.id || '');
        node.dataset.widgetType = view.type;
        node.draggable = draggable;
        node.style.setProperty('--filmstrip-fill', view.fill || 'var(--bb-widget-bg)');
        node.style.setProperty('--filmstrip-stroke', view.stroke || 'var(--bb-widget-border)');
        node.style.setProperty('--filmstrip-text', view.textColor || 'var(--bb-widget-text)');

        if (view.type === 'shape') {
            const shape = node.querySelector('[data-role="filmstrip-shape"]');
            shape.removeAttribute('hidden');
            for (const kind of ['rectangle', 'rounded', 'ellipse', 'diamond', 'triangle']) {
                shape.querySelector(`[data-role="filmstrip-shape-${kind}"]`)
                    .toggleAttribute('hidden', kind !== view.shapeKind);
            }
            shape.querySelector('[data-role="filmstrip-shape-label"]').textContent = view.title;
        } else if (view.type === 'line') {
            const line = node.querySelector('[data-role="filmstrip-line"]');
            const segment = line.querySelector('[data-role="filmstrip-line-segment"]');
            const geometry = widget?.properties?.geometry || {};
            const lineProperties = widget?.properties?.line || {};
            const width = Math.max(1, Number(geometry.width || 1));
            const height = Math.max(1, Number(geometry.height || 1));
            segment.setAttribute('x1', String(Number(lineProperties.x1 ?? 0) / width * 100));
            segment.setAttribute('y1', String(Number(lineProperties.y1 ?? height / 2) / height * 100));
            segment.setAttribute('x2', String(Number(lineProperties.x2 ?? width) / width * 100));
            segment.setAttribute('y2', String(Number(lineProperties.y2 ?? height / 2) / height * 100));
            line.removeAttribute('hidden');
        } else if (view.type === 'image' && view.imageUrl) {
            const frame = node.querySelector('[data-role="filmstrip-image-frame"]');
            const image = frame.querySelector('[data-role="filmstrip-image"]');
            image.alt = view.imageAlt;
            image.src = view.imageUrl;
            frame.hidden = false;
        } else {
            const content = node.querySelector('[data-role="filmstrip-content"]');
            content.hidden = false;
            content.querySelector('[data-role="filmstrip-content-kicker"]').textContent = view.kicker;
            content.querySelector('[data-role="filmstrip-content-title"]').textContent = view.title;
            content.querySelector('[data-role="filmstrip-content-text"]').textContent = view.body;
            const list = content.querySelector('[data-role="filmstrip-content-list"]');
            const itemTemplate = templateContent(this.element, 'workspace-filmstrip-list-item');
            const fragment = document.createDocumentFragment();
            for (const itemText of view.items) {
                const item = itemTemplate?.cloneNode(true);
                const label = item?.querySelector?.('[data-role="filmstrip-content-item-text"]');
                if (!label) continue;
                label.textContent = itemText;
                fragment.append(item);
            }
            list.replaceChildren(fragment);
        }
        return node;
    },

    scheduleWorkspaceTabActivation(boardId = '') {
        const targetBoardId = String(boardId || '').trim();
        if (targetBoardId === this.workspaceTabActivationBoardId) return;
        globalThis.clearTimeout(this.workspaceTabActivationTimer);
        this.workspaceTabActivationBoardId = targetBoardId;
        if (!targetBoardId) {
            this.clearWorkspaceTabActivation();
            return;
        }
        this.workspaceTabActivationTimer = globalThis.setTimeout(() => {
            if (this.workspaceTabActivationBoardId !== targetBoardId) return;
            void this.beginWorkspaceDrop(targetBoardId);
        }, 450);
    },

    beginWorkspaceDrop(targetBoardId = '') {
        const destinationBoardId = String(targetBoardId || '').trim();
        const sourceBoardId = String(this.workspace?.activeBoardId || '').trim();
        if (!destinationBoardId || destinationBoardId === sourceBoardId || this.workspaceDropState) return;
        let widgetIds = [];
        let sourceBounds = null;
        let pointerId = null;
        let startClientX = 0;
        let startClientY = 0;
        if (this.dragState) {
            const state = this.dragState;
            widgetIds = resolveFilmstripTransferWidgetIds(this.blackboard, state.widget?.id, this.selectedWidgetIds);
            sourceBounds = getFilmstripSelectionBounds(this.blackboard?.widgets || [], widgetIds);
            pointerId = state.pointerId;
            startClientX = state.startX;
            startClientY = state.startY;
            state.node.style.left = `${state.originX}px`;
            state.node.style.top = `${state.originY}px`;
            state.node?.releasePointerCapture?.(pointerId);
            this.detachDragListeners?.(state.node);
            this.dragState = null;
        } else if (this.groupDragState) {
            const state = this.groupDragState;
            widgetIds = this.getGroupMembers(state.groupId).map((widget) => widget.id);
            sourceBounds = getFilmstripSelectionBounds(this.blackboard?.widgets || [], widgetIds);
            pointerId = state.pointerId;
            startClientX = state.startX;
            startClientY = state.startY;
            state.captureNode?.releasePointerCapture?.(pointerId);
            this.detachGroupDrag?.(state);
            this.groupDragState = null;
            this.renderWidgets?.();
        }
        if (!widgetIds.length || !sourceBounds) return;
        const startPoint = this.getBoardPointFromEvent?.({clientX: startClientX, clientY: startClientY}) || sourceBounds;
        const state = {
            sourceBoardId,
            targetBoardId: destinationBoardId,
            widgetIds,
            sourceBounds,
            grabOffset: {
                x: clamp(Number(startPoint.x || 0) - sourceBounds.x, 0, sourceBounds.width),
                y: clamp(Number(startPoint.y || 0) - sourceBounds.y, 0, sourceBounds.height),
            },
            pointerId,
            clientX: startClientX,
            clientY: startClientY,
            placement: {x: sourceBounds.x, y: sourceBounds.y},
            insideBoard: false,
            ghost: null,
            activationError: null,
            activationPromise: null,
        };
        this.workspaceDropState = state;
        this.clearWorkspaceTabActivation();
        this.attachWorkspaceDropListeners();
        state.activationPromise = this.adapter.sendWorkspaceAction('board-activate', {boardId: destinationBoardId})
            .then(() => {
                if (this.workspaceDropState !== state) return false;
                this.createWorkspaceDropGhost(state);
                this.updateWorkspaceDropPreview(state.clientX, state.clientY);
                return true;
            })
            .catch((error) => {
                state.activationError = error;
                return false;
            });
    },

    attachWorkspaceDropListeners() {
        if (typeof document === 'undefined') return;
        document.addEventListener('pointermove', this.handleWorkspaceDropPointerMoveEvent, true);
        document.addEventListener('pointerup', this.handleWorkspaceDropPointerUpEvent, true);
        document.addEventListener('pointercancel', this.handleWorkspaceDropPointerCancelEvent, true);
    },

    detachWorkspaceDropListeners() {
        if (typeof document === 'undefined') return;
        document.removeEventListener('pointermove', this.handleWorkspaceDropPointerMoveEvent, true);
        document.removeEventListener('pointerup', this.handleWorkspaceDropPointerUpEvent, true);
        document.removeEventListener('pointercancel', this.handleWorkspaceDropPointerCancelEvent, true);
    },

    createWorkspaceDropGhost(state) {
        if (!state || state.ghost || !this.board) return;
        const source = templateContent(this.element, 'workspace-transfer-ghost');
        const ghost = source?.cloneNode(true)?.querySelector?.('[data-role="workspace-transfer-ghost"]');
        if (!ghost) return;
        ghost.querySelector('[data-role="workspace-transfer-ghost-label"]').textContent = state.widgetIds.length === 1
            ? 'Move item'
            : `Move ${state.widgetIds.length} items`;
        ghost.style.width = `${Math.max(24, state.sourceBounds.width)}px`;
        ghost.style.height = `${Math.max(18, state.sourceBounds.height)}px`;
        state.ghost = ghost;
        this.board.append(ghost);
    },

    handleWorkspaceDropPointerMove(event) {
        const state = this.workspaceDropState;
        if (!state || (state.pointerId !== null && event.pointerId !== state.pointerId)) return;
        state.clientX = event.clientX;
        state.clientY = event.clientY;
        this.updateWorkspaceDropPreview(event.clientX, event.clientY);
    },

    updateWorkspaceDropPreview(clientX, clientY) {
        const state = this.workspaceDropState;
        const rect = this.board?.getBoundingClientRect?.();
        if (!state || !rect) return;
        state.insideBoard = clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
        const point = this.getBoardPointFromEvent?.({clientX, clientY});
        if (point) state.placement = resolveWorkspaceDropPlacement(point, state.sourceBounds, state.grabOffset, this.blackboard);
        if (state.ghost) {
            state.ghost.hidden = !state.insideBoard;
            state.ghost.style.left = `${state.placement.x}px`;
            state.ghost.style.top = `${state.placement.y}px`;
        }
    },

    async finishWorkspaceDrop(event) {
        const state = this.workspaceDropState;
        if (!state || (state.pointerId !== null && event.pointerId !== state.pointerId)) return;
        event.preventDefault?.();
        this.detachWorkspaceDropListeners();
        state.clientX = event.clientX;
        state.clientY = event.clientY;
        await state.activationPromise;
        if (this.workspaceDropState !== state) return;
        this.updateWorkspaceDropPreview(state.clientX, state.clientY);
        state.ghost?.remove?.();
        this.workspaceDropState = null;
        if (state.activationError) {
            const message = state.activationError?.message || 'Could not activate the destination workspace.';
            if (typeof globalThis.assistOS?.showToast === 'function') globalThis.assistOS.showToast(message, 'error', 3000);
            else console.error('[WebMeetBlackboard] Workspace activation failed', state.activationError);
            return;
        }
        if (!state.insideBoard) return;
        await this.adapter.sendWorkspaceAction('board-transfer', {
            boardId: state.sourceBoardId,
            targetBoardId: state.targetBoardId,
            widgetIds: state.widgetIds,
            placement: state.placement,
        });
    },

    cancelWorkspaceDrop() {
        const state = this.workspaceDropState;
        if (!state) return;
        this.detachWorkspaceDropListeners();
        state.ghost?.remove?.();
        this.workspaceDropState = null;
    },

    clearWorkspaceTabActivation() {
        globalThis.clearTimeout(this.workspaceTabActivationTimer);
        this.workspaceTabActivationBoardId = '';
    },

    applyWorkspace(workspace, { animate = true } = {}) {
        if (!workspace) return;
        const previousId = String(this.workspace?.activeBoardId || '');
        const nextId = String(workspace.activeBoardId || '');
        const previousIndex = boardIndex(this.workspace, previousId);
        const nextIndex = boardIndex(workspace, nextId);
        if (animate && previousId && nextId && previousId !== nextId) {
            this.prepareWorkspaceTransition(nextIndex >= previousIndex ? 'forward' : 'backward');
        }
        this.workspace = workspace;
        this.workspaceTabActivationBoardId = '';
        if (workspace.activeBoard) {
            this.boardCache.set(nextId, workspace.activeBoard);
            this.setBlackboardState(workspace.activeBoard);
            this.renderWidgets();
        }
        this.renderWorkspaceTabs();
        if (this.filmstripOpen) this.renderWorkspaceFilmstrip();
    },

    prepareWorkspaceTransition(direction = 'forward') {
        if (!this.workspaceStage || !this.transitionLayer || !this.board) return;
        this.transitionLayer.replaceChildren(...[...this.board.childNodes].map((node) => node.cloneNode(true)));
        this.transitionLayer.hidden = false;
        this.workspaceStage.classList.remove('is-slide-forward', 'is-slide-backward');
        void this.workspaceStage.offsetWidth;
        this.workspaceStage.classList.add(direction === 'backward' ? 'is-slide-backward' : 'is-slide-forward');
        globalThis.clearTimeout(this.workspaceTransitionTimer);
        this.workspaceTransitionTimer = globalThis.setTimeout(() => {
            this.workspaceStage?.classList.remove('is-slide-forward', 'is-slide-backward');
            if (this.transitionLayer) {
                this.transitionLayer.hidden = true;
                this.transitionLayer.replaceChildren();
            }
        }, 240);
    },

    renderWorkspaceTabs() {
        if (!this.workspaceTabs) return;
        const source = templateContent(this.element, 'workspace-tab');
        const fragment = document.createDocumentFragment();
        const summaries = new Map((this.workspace?.boards || []).map((board) => [String(board.boardId), board]));
        for (const boardId of this.workspace?.boardOrder || []) {
            const summary = summaries.get(String(boardId));
            if (!source || !summary) continue;
            const node = source.cloneNode(true);
            const shell = node.querySelector('.webmeet-blackboard-tab-shell');
            const tab = node.querySelector('[role="tab"]');
            const selected = String(boardId) === String(this.workspace.activeBoardId);
            shell.dataset.boardId = String(boardId);
            tab.dataset.boardId = String(boardId);
            tab.textContent = String(summary.title || 'Workspace');
            tab.id = `webmeet-blackboard-tab-${String(boardId).replace(/[^a-z0-9_-]/gi, '-')}`;
            tab.setAttribute('aria-selected', selected ? 'true' : 'false');
            tab.tabIndex = selected ? 0 : -1;
            const input = node.querySelector('[data-role="workspace-tab-title-input"]');
            input.dataset.boardId = String(boardId);
            input.value = String(summary.title || 'Workspace');
            if (this.renamingWorkspaceBoardId === String(boardId)) {
                tab.hidden = true;
                input.hidden = false;
            }
            for (const action of node.querySelectorAll('.webmeet-blackboard-tab-menu')) action.dataset.boardId = String(boardId);
            fragment.append(node);
        }
        this.workspaceTabs.replaceChildren(fragment);
        if (this.renamingWorkspaceBoardId) {
            const input = [...this.workspaceTabs.querySelectorAll('[data-role="workspace-tab-title-input"]')]
                .find((entry) => entry.dataset.boardId === this.renamingWorkspaceBoardId);
            input?.focus?.();
            input?.select?.();
        }
        if (this.board) this.board.setAttribute('aria-labelledby', this.workspaceTabs.querySelector('[aria-selected="true"]')?.id || '');
    },

    async activateWorkspaceBoard(target) {
        const boardId = String(target?.dataset?.boardId || '').trim();
        if (!boardId || boardId === this.workspace?.activeBoardId || this.busy) return;
        await this.flushInlineTextEdit?.();
        this.busy = true;
        this.updateToolbarState();
        try {
            await this.adapter.sendWorkspaceAction('board-activate', { boardId });
            this.setFilmstripOpen(false);
        } finally {
            this.busy = false;
            this.updateToolbarState();
        }
    },

    async createWorkspaceBoard() {
        if (this.busy) return;
        const number = Number(this.workspace?.boards?.length || 0) + 1;
        this.busy = true;
        this.updateToolbarState();
        try {
            await this.adapter.sendWorkspaceAction('board-create', { title: `Workspace ${number}` });
        } finally {
            this.busy = false;
            this.updateToolbarState();
        }
    },

    renameWorkspaceBoard(target) {
        const boardId = String(target?.dataset?.boardId || '').trim();
        const summary = (this.workspace?.boards || []).find((board) => String(board.boardId) === boardId);
        if (summary?.systemManaged === true) return;
        if (!boardId || !summary) return;
        this.renamingWorkspaceBoardId = boardId;
        this.renderWorkspaceTabs();
    },

    async commitWorkspaceBoardRename(input) {
        const boardId = String(input?.dataset?.boardId || '').trim();
        const title = String(input?.value || '').trim();
        if (!boardId || boardId !== this.renamingWorkspaceBoardId) return;
        const currentTitle = String((this.workspace?.boards || [])
            .find((board) => String(board.boardId) === boardId)?.title || '').trim();
        this.renamingWorkspaceBoardId = '';
        this.renderWorkspaceTabs();
        if (!title || title === currentTitle) return;
        await this.adapter.sendWorkspaceAction('board-rename', { boardId, title: String(title).trim() });
    },

    handleWorkspaceTitleChange(event) {
        const input = event.target?.closest?.('[data-role="workspace-tab-title-input"]');
        if (input) void this.commitWorkspaceBoardRename(input);
    },

    handleWorkspaceTitleFocusOut(event) {
        const input = event.target?.closest?.('[data-role="workspace-tab-title-input"]');
        if (input) void this.commitWorkspaceBoardRename(input);
    },

    handleWorkspaceTitleKeydown(event) {
        const input = event.target?.closest?.('[data-role="workspace-tab-title-input"]');
        if (!input) return;
        if (event.key === 'Enter') {
            event.preventDefault();
            void this.commitWorkspaceBoardRename(input);
        } else if (event.key === 'Escape') {
            event.preventDefault();
            this.renamingWorkspaceBoardId = '';
            this.renderWorkspaceTabs();
        }
    },

    handleWorkspaceTabDoubleClick(event) {
        const tab = event.target?.closest?.('.webmeet-blackboard-tab');
        if (!tab) return;
        event.preventDefault();
        event.stopPropagation();
        this.renameWorkspaceBoard(tab);
    },

    async deleteWorkspaceBoard(target) {
        const boardId = String(target?.dataset?.boardId || '').trim();
        if (!boardId || (this.workspace?.boardOrder || []).length <= 1) return;
        const summary = (this.workspace?.boards || []).find((board) => String(board.boardId) === boardId);
        let confirmed = true;
        if (Number(summary?.widgetCount || 0) > 0 && globalThis.assistOS?.UI?.showModal) {
            const result = await globalThis.assistOS.UI.showModal('confirm-action-modal', {
                message: encodeURIComponent(`Delete "${String(summary.title || 'Workspace')}" and its content?`),
            }, true);
            confirmed = result === true || result?.confirmed === true;
        } else if (Number(summary?.widgetCount || 0) > 0) {
            confirmed = globalThis.confirm?.(`Delete "${String(summary.title || 'Workspace')}" and its content?`) === true;
        }
        if (!confirmed) return;
        await this.adapter.sendWorkspaceAction('board-delete', { boardId });
    },

    toggleWorkspaceFilmstrip(target) {
        this.setFilmstripOpen(!this.filmstripOpen);
        target?.setAttribute?.('aria-pressed', this.filmstripOpen ? 'true' : 'false');
    },

    setFilmstripOpen(open) {
        this.filmstripOpen = open === true;
        if (this.workspaceFilmstrip) this.workspaceFilmstrip.hidden = !this.filmstripOpen;
        if (this.workspaceStage) this.workspaceStage.hidden = this.filmstripOpen;
        const toggle = this.element.querySelector('[data-local-action="toggleWorkspaceFilmstrip"]');
        toggle?.setAttribute('aria-pressed', this.filmstripOpen ? 'true' : 'false');
        if (this.filmstripOpen) void this.loadWorkspaceFilmstrip();
    },

    async loadWorkspaceFilmstrip() {
        const ids = this.workspace?.boardOrder || [];
        await Promise.all(ids.map(async (boardId) => {
            if (this.boardCache.has(boardId)) return;
            const board = await this.adapter.fetchBoardProjection(boardId).catch(() => null);
            if (board) this.boardCache.set(boardId, board);
        }));
        if (this.filmstripOpen) this.renderWorkspaceFilmstrip();
    },

    renderWorkspaceFilmstrip() {
        if (!this.workspaceFilmstripTrack) return;
        const cardTemplate = templateContent(this.element, 'workspace-filmstrip-card');
        const groupTemplate = templateContent(this.element, 'workspace-filmstrip-group');
        const summaries = new Map((this.workspace?.boards || []).map((board) => [String(board.boardId), board]));
        const fragment = document.createDocumentFragment();
        for (const boardId of this.workspace?.boardOrder || []) {
            const summary = summaries.get(String(boardId));
            if (!summary || !cardTemplate) continue;
            const node = cardTemplate.cloneNode(true);
            const card = node.querySelector('.webmeet-blackboard-filmstrip-card');
            const openButton = node.querySelector('.webmeet-blackboard-filmstrip-open');
            const preview = node.querySelector('[data-role="filmstrip-preview"]');
            card.dataset.boardId = String(boardId);
            card.setAttribute('aria-label', `${String(summary.title || 'Workspace')} workspace. Paste destination.`);
            openButton.dataset.boardId = String(boardId);
            node.querySelector('[data-role="filmstrip-title"]').textContent = String(summary.title || 'Workspace');
            node.querySelector('[data-role="filmstrip-count"]').textContent = `${Number(summary.widgetCount || 0)} items`;
            const board = this.boardCache.get(boardId);
            const widgets = Array.isArray(board?.widgets) ? board.widgets : [];
            const groupPreviews = getFilmstripGroupPreviews(widgets);
            const groupedIds = new Set(groupPreviews.flatMap((group) => (
                widgets
                    .filter((widget) => String(widget.groupId || '') === group.groupId)
                    .map((widget) => String(widget.id || ''))
            )));
            const projectedWidgets = widgets.map((widget) => projectFilmstripConnection(widget, widgets));
            const geometries = projectedWidgets.map((widget) => widget.properties?.geometry).filter(Boolean);
            const right = Math.max(1200, ...geometries.map((geometry) => Number(geometry.x || 0) + Number(geometry.width || 1)));
            const bottom = Math.max(800, ...geometries.map((geometry) => Number(geometry.y || 0) + Number(geometry.height || 1)));
            for (const widget of projectedWidgets) {
                const geometry = widget.properties?.geometry;
                if (!geometry) continue;
                const widgetNode = this.renderFilmstripWidget(widget, { boardId });
                if (!widgetNode) continue;
                const grouped = groupedIds.has(String(widget.id || ''));
                widgetNode.classList.toggle('is-group-member', grouped);
                widgetNode.dataset.groupId = grouped ? String(widget.groupId || '') : '';
                widgetNode.draggable = !grouped;
                widgetNode.title = grouped ? '' : 'Drag this item to another workspace';
                if (grouped) widgetNode.setAttribute('aria-hidden', 'true');
                else widgetNode.setAttribute('aria-label', `Movable ${String(widget.type || 'item')}`);
                widgetNode.style.left = `${Math.max(0, Number(geometry.x || 0) / right * 100)}%`;
                widgetNode.style.top = `${Math.max(0, Number(geometry.y || 0) / bottom * 100)}%`;
                widgetNode.style.width = `${Math.max(2, Number(geometry.width || 1) / right * 100)}%`;
                widgetNode.style.height = `${Math.max(2, Number(geometry.height || 1) / bottom * 100)}%`;
                preview.append(widgetNode);
            }
            for (const group of groupPreviews) {
                const groupNode = groupTemplate?.cloneNode(true)?.querySelector?.('.webmeet-blackboard-filmstrip-group');
                if (!groupNode) continue;
                groupNode.dataset.boardId = String(boardId);
                groupNode.dataset.widgetId = group.representativeId;
                groupNode.dataset.groupId = group.groupId;
                groupNode.title = `Drag this group of ${group.memberCount} items to another workspace`;
                groupNode.setAttribute('aria-label', `Movable group of ${group.memberCount} items`);
                groupNode.querySelector('[data-role="filmstrip-group-label"]').textContent = `Group · ${group.memberCount}`;
                groupNode.style.left = `${Math.max(0, group.bounds.x / right * 100)}%`;
                groupNode.style.top = `${Math.max(0, group.bounds.y / bottom * 100)}%`;
                groupNode.style.width = `${Math.max(2, group.bounds.width / right * 100)}%`;
                groupNode.style.height = `${Math.max(2, group.bounds.height / bottom * 100)}%`;
                preview.append(groupNode);
            }
            fragment.append(node);
        }
        this.workspaceFilmstripTrack.replaceChildren(fragment);
        this.projectFilmstripClipboardState();
    },

    async activateFilmstripBoard(target) {
        await this.activateWorkspaceBoard(target);
    },

    bindWorkspaceGestures() {
        if (!this.workspaceTabs) return;
        this.workspaceTabs.removeEventListener('dragstart', this.handleWorkspaceTabDragStart);
        this.workspaceTabs.removeEventListener('dragover', this.handleWorkspaceTabDragOver);
        this.workspaceTabs.removeEventListener('drop', this.handleWorkspaceTabDrop);
        this.workspaceTabs.removeEventListener('dragend', this.handleWorkspaceTabDragEnd);
        this.workspaceTabs.removeEventListener('change', this.handleWorkspaceTitleChangeEvent);
        this.workspaceTabs.removeEventListener('keydown', this.handleWorkspaceTitleKeydownEvent);
        this.workspaceTabs.removeEventListener('focusout', this.handleWorkspaceTitleFocusOutEvent);
        this.workspaceTabs.removeEventListener('dblclick', this.handleWorkspaceTabDoubleClickEvent);
        this.workspaceTabs.addEventListener('dragstart', this.handleWorkspaceTabDragStart);
        this.workspaceTabs.addEventListener('dragover', this.handleWorkspaceTabDragOver);
        this.workspaceTabs.addEventListener('drop', this.handleWorkspaceTabDrop);
        this.workspaceTabs.addEventListener('dragend', this.handleWorkspaceTabDragEnd);
        this.workspaceTabs.addEventListener('change', this.handleWorkspaceTitleChangeEvent);
        this.workspaceTabs.addEventListener('keydown', this.handleWorkspaceTitleKeydownEvent);
        this.workspaceTabs.addEventListener('focusout', this.handleWorkspaceTitleFocusOutEvent);
        this.workspaceTabs.addEventListener('dblclick', this.handleWorkspaceTabDoubleClickEvent);
        if (!this.workspaceFilmstripTrack) return;
        this.workspaceFilmstripTrack.removeEventListener('dragstart', this.handleFilmstripDragStartEvent);
        this.workspaceFilmstripTrack.removeEventListener('dragover', this.handleFilmstripDragOverEvent);
        this.workspaceFilmstripTrack.removeEventListener('dragleave', this.handleFilmstripDragLeaveEvent);
        this.workspaceFilmstripTrack.removeEventListener('drop', this.handleFilmstripDropEvent);
        this.workspaceFilmstripTrack.removeEventListener('dragend', this.handleFilmstripDragEndEvent);
        this.workspaceFilmstripTrack.removeEventListener('contextmenu', this.handleFilmstripContextMenuEvent);
        this.workspaceFilmstripTrack.addEventListener('dragstart', this.handleFilmstripDragStartEvent);
        this.workspaceFilmstripTrack.addEventListener('dragover', this.handleFilmstripDragOverEvent);
        this.workspaceFilmstripTrack.addEventListener('dragleave', this.handleFilmstripDragLeaveEvent);
        this.workspaceFilmstripTrack.addEventListener('drop', this.handleFilmstripDropEvent);
        this.workspaceFilmstripTrack.addEventListener('dragend', this.handleFilmstripDragEndEvent);
        this.workspaceFilmstripTrack.addEventListener('contextmenu', this.handleFilmstripContextMenuEvent);
    },

    handleFilmstripDragStart(event) {
        const node = event.target?.closest?.('[data-role="filmstrip-widget"]');
        const sourceBoardId = String(node?.dataset?.boardId || '').trim();
        const widgetId = String(node?.dataset?.widgetId || '').trim();
        const board = this.boardCache.get(sourceBoardId);
        const selectedIds = sourceBoardId === String(this.workspace?.activeBoardId || '')
            ? this.selectedWidgetIds
            : [];
        const widgetIds = resolveFilmstripTransferWidgetIds(board, widgetId, selectedIds);
        if (!node || !sourceBoardId || !widgetIds.length) {
            event.preventDefault?.();
            return;
        }
        const sourceBounds = getFilmstripSelectionBounds(board?.widgets || [], widgetIds);
        const preview = node.closest?.('[data-role="filmstrip-preview"]');
        const logicalWidth = Math.max(1, Number(preview?.dataset?.logicalWidth || 1200));
        const logicalHeight = Math.max(1, Number(preview?.dataset?.logicalHeight || 800));
        const point = getFilmstripLogicalPoint(
            event.clientX,
            event.clientY,
            preview?.getBoundingClientRect?.() || {},
            logicalWidth,
            logicalHeight,
        );
        this.filmstripDragState = {
            sourceBoardId,
            widgetIds,
            node,
            sourceBounds: sourceBounds || {x: 0, y: 0, width: 1, height: 1},
            grabOffset: {
                x: sourceBounds ? clamp(point.x - sourceBounds.x, 0, sourceBounds.width) : 0,
                y: sourceBounds ? clamp(point.y - sourceBounds.y, 0, sourceBounds.height) : 0,
            },
        };
        node.classList.add('is-dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', `Blackboard ${widgetIds.length === 1 ? 'item' : 'selection'}`);
        }
    },

    handleFilmstripDragOver(event) {
        const card = event.target?.closest?.('.webmeet-blackboard-filmstrip-card');
        const targetBoardId = String(card?.dataset?.boardId || '').trim();
        if (!card || !targetBoardId) return;
        if (this.hasTransferredFiles?.(event.dataTransfer)) {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            for (const item of this.workspaceFilmstripTrack.querySelectorAll('.is-drag-over')) item.classList.remove('is-drag-over');
            card.classList.add('is-drag-over');
            return;
        }
        if (!this.filmstripDragState) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        for (const item of this.workspaceFilmstripTrack.querySelectorAll('.is-drag-over')) item.classList.remove('is-drag-over');
        card.classList.add('is-drag-over');
    },

    handleFilmstripDragLeave(event) {
        const card = event.target?.closest?.('.webmeet-blackboard-filmstrip-card');
        if (!card || card.contains(event.relatedTarget)) return;
        card.classList.remove('is-drag-over');
    },

    async handleFilmstripDrop(event) {
        const card = event.target?.closest?.('.webmeet-blackboard-filmstrip-card');
        const targetBoardId = String(card?.dataset?.boardId || '').trim();
        const transfer = this.filmstripDragState;
        if (!card || !targetBoardId) return;
        if (this.hasTransferredFiles?.(event.dataTransfer)) {
            event.preventDefault();
            event.stopPropagation?.();
            const preview = card.querySelector('[data-role="filmstrip-preview"]');
            const position = getFilmstripLogicalPoint(
                event.clientX,
                event.clientY,
                preview?.getBoundingClientRect?.() || {},
                Number(preview?.dataset?.logicalWidth || 1200),
                Number(preview?.dataset?.logicalHeight || 800),
            );
            card.classList.remove('is-drag-over');
            this.publishTransferredFiles?.(this.getTransferredFiles?.(event.dataTransfer), {
                boardId: targetBoardId,
                position
            });
            return;
        }
        if (!transfer) return;
        event.preventDefault();
        const preview = card.querySelector('[data-role="filmstrip-preview"]');
        const placement = resolveFilmstripDropPlacement({
            clientX: event.clientX,
            clientY: event.clientY,
            previewRect: preview?.getBoundingClientRect?.() || {},
            logicalWidth: Number(preview?.dataset?.logicalWidth || 1200),
            logicalHeight: Number(preview?.dataset?.logicalHeight || 800),
            sourceBounds: transfer.sourceBounds,
            grabOffset: transfer.grabOffset,
        });
        this.handleFilmstripDragEnd();
        this.boardCache.delete(transfer.sourceBoardId);
        this.boardCache.delete(targetBoardId);
        await this.adapter.sendWorkspaceAction('board-transfer', {
            boardId: transfer.sourceBoardId,
            targetBoardId,
            widgetIds: transfer.widgetIds,
            placement,
        });
        if (this.filmstripOpen) await this.loadWorkspaceFilmstrip();
    },

    handleFilmstripDragEnd() {
        this.filmstripDragState?.node?.classList?.remove?.('is-dragging');
        this.filmstripDragState = null;
        for (const item of this.workspaceFilmstripTrack?.querySelectorAll?.('.is-drag-over') || []) item.classList.remove('is-drag-over');
    },

    handleWorkspaceTabDragStart(event) {
        const shell = event.target?.closest?.('.webmeet-blackboard-tab-shell');
        this.draggedWorkspaceBoardId = String(shell?.dataset?.boardId || '');
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    },

    handleWorkspaceTabDragOver(event) {
        const shell = event.target?.closest?.('.webmeet-blackboard-tab-shell');
        if (!shell || !this.draggedWorkspaceBoardId) return;
        event.preventDefault();
        for (const item of this.workspaceTabs.querySelectorAll('.is-drag-over')) item.classList.remove('is-drag-over');
        shell.classList.add('is-drag-over');
    },

    async handleWorkspaceTabDrop(event) {
        const shell = event.target?.closest?.('.webmeet-blackboard-tab-shell');
        const boardId = this.draggedWorkspaceBoardId;
        if (!shell || !boardId) return;
        event.preventDefault();
        const targetBoardId = String(shell.dataset.boardId || '');
        const targetIndex = (this.workspace?.boardOrder || []).indexOf(targetBoardId);
        this.handleWorkspaceTabDragEnd();
        if (targetIndex < 0 || boardId === targetBoardId) return;
        await this.adapter.sendWorkspaceAction('board-reorder', { boardId, targetIndex });
    },

    handleWorkspaceTabDragEnd() {
        this.draggedWorkspaceBoardId = '';
        for (const item of this.workspaceTabs?.querySelectorAll?.('.is-drag-over') || []) item.classList.remove('is-drag-over');
    },
};
