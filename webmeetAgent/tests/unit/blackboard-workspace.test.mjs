import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BlackboardWorkspace } from '../../lib/blackboard/workspace-model.mjs';
import { WebMeetBlackboardPanel } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.js';
import {
    blackboardWorkspaceMethods,
    getFilmstripGroupPreviews,
    getFilmstripSelectionBounds,
    getFilmstripWidgetView,
    resolveClipboardPastePlacement,
    resolveFilmstripDropPlacement,
    resolveFilmstripTransferWidgetIds,
    resolveWorkspaceDropPlacement,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-workspaces.js';

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const panelRoot = path.resolve(testRoot, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel');

function addWidget(board, id, x = 10, y = 20) {
    board.addWidget({ id, type: 'shape', properties: { geometry: { x, y, width: 100, height: 60 } } }, { record: false });
}

test('BlackboardWorkspace creates, activates, renames, reorders and deletes shared zones', () => {
    const workspace = new BlackboardWorkspace({ roomId: 'room-1' });
    const firstId = workspace.activeBoardId;
    const second = workspace.createBoard({ title: 'Diagram' });
    assert.equal(workspace.activeBoardId, second.boardId);
    workspace.renameBoard(second.boardId, 'Images');
    assert.equal(workspace.getBoard(second.boardId).metadata.title, 'Images');
    workspace.reorderBoard(second.boardId, 0);
    assert.deepEqual(workspace.boardOrder, [second.boardId, firstId]);
    workspace.deleteBoard(firstId);
    assert.deepEqual(workspace.boardOrder, [second.boardId]);
    assert.throws(() => workspace.deleteBoard(second.boardId), /last Blackboard workspace zone/);
});

test('cross-zone transfer preserves selection geometry and global undo restores both zones', () => {
    const workspace = new BlackboardWorkspace({ roomId: 'room-2' });
    const source = workspace.activeBoard;
    const target = workspace.createBoard({ title: 'Target' }, { activate: false });
    addWidget(source, 'a', 50, 70);
    addWidget(source, 'b', 190, 70);
    source.addWidget({
        id: 'line-ab', type: 'line', properties: {
            geometry: { x: 50, y: 70, width: 240, height: 60 },
            connection: { from: { widgetId: 'a', anchor: 'right' }, to: { widgetId: 'b', anchor: 'left' } },
        },
    }, { record: false });
    workspace.transferWidgets({
        sourceBoardId: source.boardId,
        targetBoardId: target.boardId,
        widgetIds: ['a', 'b'],
        placement: { x: 300, y: 200 },
    });
    assert.equal(source.widgets.size, 0);
    assert.deepEqual([...target.widgets.keys()].sort(), ['a', 'b', 'line-ab']);
    assert.equal(target.getWidget('a').properties.geometry.x, 300);
    assert.equal(target.getWidget('a').properties.geometry.y, 200);
    assert.equal(workspace.activeBoardId, target.boardId);
    workspace.undo();
    assert.deepEqual([...workspace.getBoard(source.boardId).widgets.keys()].sort(), ['a', 'b', 'line-ab']);
    assert.equal(workspace.getBoard(target.boardId).widgets.size, 0);
    workspace.redo();
    assert.deepEqual([...workspace.getBoard(target.boardId).widgets.keys()].sort(), ['a', 'b', 'line-ab']);
});

test('cross-zone transfer removes connections that cross the selection boundary', () => {
    const workspace = new BlackboardWorkspace({ roomId: 'room-3' });
    const source = workspace.activeBoard;
    const target = workspace.createBoard({ title: 'Target' }, { activate: false });
    addWidget(source, 'a');
    addWidget(source, 'b', 200, 20);
    source.addWidget({
        id: 'external-line', type: 'line', properties: {
            geometry: { x: 10, y: 20, width: 290, height: 60 },
            connection: { from: { widgetId: 'a', anchor: 'right' }, to: { widgetId: 'b', anchor: 'left' } },
        },
    }, { record: false });
    workspace.transferWidgets({ sourceBoardId: source.boardId, targetBoardId: target.boardId, widgetIds: ['a'] });
    assert.equal(source.getWidget('external-line'), null);
    assert.equal(target.getWidget('external-line'), null);
});

test('same-zone filmstrip transfer repositions widgets and groups as one undo step', () => {
    const workspace = new BlackboardWorkspace({ roomId: 'room-same-zone' });
    const board = workspace.activeBoard;
    addWidget(board, 'a', 50, 70);
    addWidget(board, 'b', 190, 70);
    board.groupWidgets(['a', 'b'], { groupId: 'group-1', record: false });

    workspace.transferWidgets({
        sourceBoardId: board.boardId,
        targetBoardId: board.boardId,
        widgetIds: ['a'],
        placement: {x: 400, y: 300},
    });
    assert.deepEqual(board.getWidget('a').properties.geometry, {x: 400, y: 300, width: 100, height: 60});
    assert.deepEqual(board.getWidget('b').properties.geometry, {x: 540, y: 300, width: 100, height: 60});
    assert.equal(workspace.history.undoStack.at(-1).action, 'board-reposition');

    workspace.undo();
    assert.deepEqual(workspace.activeBoard.getWidget('a').properties.geometry, {x: 50, y: 70, width: 100, height: 60});
    assert.deepEqual(workspace.activeBoard.getWidget('b').properties.geometry, {x: 190, y: 70, width: 100, height: 60});
    workspace.redo();
    assert.deepEqual(workspace.activeBoard.getWidget('a').properties.geometry, {x: 400, y: 300, width: 100, height: 60});
});

test('workspace copy clones a complete group and remaps its attached connections atomically', () => {
    const workspace = new BlackboardWorkspace({roomId: 'room-copy'});
    const source = workspace.activeBoard;
    const target = workspace.createBoard({title: 'Copy target'}, {activate: false});
    addWidget(source, 'a', 40, 60);
    addWidget(source, 'b', 180, 60);
    source.addWidget({
        id: 'line-ab', type: 'line', properties: {
            geometry: {x: 40, y: 60, width: 240, height: 60},
            connection: {from: {widgetId: 'a', anchor: 'right'}, to: {widgetId: 'b', anchor: 'left'}},
        },
    }, {record: false});
    source.groupWidgets(['a', 'b', 'line-ab'], {groupId: 'group-source', record: false});

    const copied = workspace.copyWidgets({
        sourceBoardId: source.boardId,
        targetBoardId: target.boardId,
        widgetIds: ['a'],
        placement: {x: 300, y: 240},
    }, {participantId: 'participant-1'});

    assert.equal(source.widgets.size, 3);
    assert.equal(target.widgets.size, 3);
    assert.equal(new Set(copied.widgetIds).size, 3);
    assert.ok(copied.widgetIds.every((id) => !['a', 'b', 'line-ab'].includes(id)));
    const clones = copied.widgetIds.map((id) => target.getWidget(id));
    assert.equal(new Set(clones.map((widget) => widget.groupId)).size, 1);
    assert.notEqual(clones[0].groupId, 'group-source');
    const line = clones.find((widget) => widget.type === 'line');
    const clonedEndpointIds = new Set(clones.filter((widget) => widget.type === 'shape').map((widget) => widget.id));
    assert.ok(clonedEndpointIds.has(line.properties.connection.from.widgetId));
    assert.ok(clonedEndpointIds.has(line.properties.connection.to.widgetId));
    assert.equal(Math.min(...clones.map((widget) => widget.properties.geometry.x)), 300);
    assert.equal(Math.min(...clones.map((widget) => widget.properties.geometry.y)), 240);
    assert.equal(workspace.activeBoardId, source.boardId);
    assert.equal(workspace.history.undoStack.at(-1).action, 'board-copy');
    workspace.undo();
    assert.equal(workspace.getBoard(target.boardId).widgets.size, 0);
});

test('workspace copy rejects the singleton SCRIPTA projection', () => {
    const workspace = new BlackboardWorkspace({roomId: 'room-copy-scripta'});
    const source = workspace.activeBoard;
    const target = workspace.createBoard({title: 'Target'}, {activate: false});
    source.addWidget({id: 'robo_scripta_document', type: 'scripta-document', properties: {}}, {record: false});
    assert.throws(() => workspace.copyWidgets({
        sourceBoardId: source.boardId,
        targetBoardId: target.boardId,
        widgetIds: ['robo_scripta_document'],
    }), /cannot be copied/);
});

test('workspace UI keeps stable WebSkel templates and declarative click actions', () => {
    const html = fs.readFileSync(path.join(panelRoot, 'webmeet-blackboard-panel.html'), 'utf8');
    const source = fs.readFileSync(path.join(panelRoot, 'webmeet-blackboard-workspaces.js'), 'utf8');
    assert.match(html, /data-template="workspace-tab"/);
    assert.match(html, /data-template="workspace-filmstrip-card"/);
    assert.match(html, /data-template="workspace-filmstrip-list-item"/);
    assert.match(html, /data-template="workspace-filmstrip-group"/);
    assert.match(html, /data-template="workspace-transfer-ghost"/);
    assert.match(html, /data-role="selection-context-menu"/);
    assert.match(html, /data-local-action="copyContextSelection"/);
    assert.match(html, /data-local-action="cutContextSelection"/);
    assert.match(html, /data-local-action="pasteContextSelectionHere"/);
    assert.match(html, /data-role="filmstrip-widget"[\s\S]*draggable="true"/);
    assert.match(html, /data-role="filmstrip-shape"/);
    assert.match(html, /data-role="filmstrip-line"/);
    assert.match(html, /data-role="filmstrip-image"/);
    assert.match(html, /data-role="filmstrip-content"/);
    assert.match(html, /data-template="file-widget"/);
    assert.match(html, /data-template="file-context-download"/);
    assert.match(html, /data-local-action="downloadBlackboardFile"/);
    assert.doesNotMatch(html, /class="webmeet-blackboard-file-download"/);
    assert.match(html, /data-role="file-drop-overlay"/);
    assert.match(html, /class="webmeet-blackboard-transition-layer"[^>]*aria-hidden="true"[^>]*hidden/);
    assert.match(html, /data-local-action="createWorkspaceBoard"/);
    assert.match(html, /data-local-action="activateWorkspaceBoard"/);
    assert.doesNotMatch(html, /data-local-action="renameWorkspaceBoard"/);
    assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML|addEventListener\(['"]click/);
    assert.match(source, /addEventListener\('dblclick', this\.handleWorkspaceTabDoubleClickEvent\)/);
    assert.match(source, /removeEventListener\('dblclick', this\.handleWorkspaceTabDoubleClickEvent\)/);
    assert.match(source, /addEventListener\('focusout', this\.handleWorkspaceTitleFocusOutEvent\)/);
    assert.match(source, /removeEventListener\('focusout', this\.handleWorkspaceTitleFocusOutEvent\)/);
    assert.match(source, /addEventListener\('drop', this\.handleFilmstripDropEvent\)/);
    assert.match(source, /removeEventListener\('drop', this\.handleFilmstripDropEvent\)/);
    assert.match(source, /projectFilmstripClipboardState/);
    assert.match(source, /shape\.removeAttribute\('hidden'\)/);
    assert.match(source, /toggleAttribute\('hidden', kind !== view\.shapeKind\)/);
    assert.match(source, /line\.removeAttribute\('hidden'\)/);
});

test('filmstrip projects each rigid group as one interactive preview region', () => {
    const previews = getFilmstripGroupPreviews([
        { id: 'a', groupId: 'group-1', properties: { geometry: { x: 20, y: 30, width: 100, height: 50 } } },
        { id: 'b', groupId: 'group-1', properties: { geometry: { x: 180, y: 60, width: 80, height: 90 } } },
        { id: 'c', properties: { geometry: { x: 400, y: 20, width: 50, height: 50 } } },
    ]);
    assert.deepEqual(previews, [{
        groupId: 'group-1',
        representativeId: 'b',
        memberCount: 2,
        bounds: { x: 20, y: 30, width: 240, height: 120 },
    }]);
});

test('filmstrip drop maps the pointer and grab offset to target board coordinates', () => {
    const widgets = [
        { id: 'a', properties: { geometry: { x: 100, y: 80, width: 120, height: 60 } } },
        { id: 'b', properties: { geometry: { x: 260, y: 120, width: 80, height: 100 } } },
    ];
    const sourceBounds = getFilmstripSelectionBounds(widgets, ['a', 'b']);
    assert.deepEqual(sourceBounds, {x: 100, y: 80, width: 240, height: 140});
    assert.deepEqual(resolveFilmstripDropPlacement({
        clientX: 250,
        clientY: 150,
        previewRect: {left: 100, top: 50, width: 300, height: 200},
        logicalWidth: 1200,
        logicalHeight: 800,
        sourceBounds,
        grabOffset: {x: 60, y: 35},
    }), {x: 540, y: 365});
    assert.deepEqual(resolveFilmstripDropPlacement({
        clientX: 400,
        clientY: 250,
        previewRect: {left: 100, top: 50, width: 300, height: 200},
        logicalWidth: 1200,
        logicalHeight: 800,
        sourceBounds,
        grabOffset: {x: 0, y: 0},
    }), {x: 960, y: 660});
});

test('clipboard paste offsets the clone and keeps it inside the target workspace', () => {
    const target = {widgets: [{properties: {geometry: {x: 0, y: 0, width: 1200, height: 800}}}]};
    assert.deepEqual(resolveClipboardPastePlacement(
        {x: 100, y: 80, width: 240, height: 140}, target,
    ), {x: 124, y: 104});
    assert.deepEqual(resolveClipboardPastePlacement(
        {x: 1100, y: 760, width: 240, height: 140}, target,
    ), {x: 960, y: 660});
});

test('cross-tab pointer placement preserves the grab offset and target bounds', () => {
    assert.deepEqual(resolveWorkspaceDropPlacement(
        {x: 340, y: 260},
        {x: 50, y: 70, width: 200, height: 120},
        {x: 40, y: 30},
        {widgets: []},
    ), {x: 300, y: 230});
    assert.deepEqual(resolveWorkspaceDropPlacement(
        {x: 1190, y: 790},
        {x: 50, y: 70, width: 200, height: 120},
        {x: 10, y: 10},
        {widgets: []},
    ), {x: 1000, y: 680});
});

test('tab hover activates the destination and pointer-up on its canvas transfers at that position', async () => {
    const calls = [];
    const node = {style: {left: '50px', top: '70px'}, releasePointerCapture() {}};
    const presenter = {
        workspace: {activeBoardId: 'source-board'},
        blackboard: {boardId: 'source-board', widgets: [
            {id: 'widget-1', type: 'shape', properties: {geometry: {x: 50, y: 70, width: 100, height: 60}}},
        ]},
        selectedWidgetIds: new Set(),
        dragState: {
            widget: {id: 'widget-1'}, node, pointerId: 7,
            startX: 75, startY: 90, originX: 50, originY: 70,
        },
        groupDragState: null,
        workspaceDropState: null,
        workspaceTabActivationTimer: null,
        workspaceTabActivationBoardId: 'target-board',
        transitionLayer: null,
        board: {getBoundingClientRect: () => ({left: 0, top: 0, right: 1200, bottom: 800})},
        adapter: {async sendWorkspaceAction(action, input) { calls.push({action, input}); }},
        getBoardPointFromEvent: ({clientX, clientY}) => ({x: clientX, y: clientY}),
        detachDragListeners() {},
        attachWorkspaceDropListeners() {},
        detachWorkspaceDropListeners() {},
        createWorkspaceDropGhost() {},
        clearWorkspaceTabActivation() {
            return blackboardWorkspaceMethods.clearWorkspaceTabActivation.call(this);
        },
        updateWorkspaceDropPreview(clientX, clientY) {
            return blackboardWorkspaceMethods.updateWorkspaceDropPreview.call(this, clientX, clientY);
        },
    };
    blackboardWorkspaceMethods.beginWorkspaceDrop.call(presenter, 'target-board');
    await presenter.workspaceDropState.activationPromise;
    assert.deepEqual(calls[0], {action: 'board-activate', input: {boardId: 'target-board'}});
    assert.equal(node.style.left, '50px');
    assert.equal(node.style.top, '70px');

    await blackboardWorkspaceMethods.finishWorkspaceDrop.call(presenter, {
        pointerId: 7, clientX: 300, clientY: 220, preventDefault() {},
    });
    assert.deepEqual(calls[1], {
        action: 'board-transfer',
        input: {
            boardId: 'source-board', targetBoardId: 'target-board', widgetIds: ['widget-1'],
            placement: {x: 275, y: 200},
        },
    });
});

test('normal and filmstrip copy clipboard paste once and clear after success', async () => {
    const calls = [];
    const copiedSelection = {
        sourceBoardId: 'source-board', widgetIds: ['a', 'b'],
        sourceBounds: {x: 100, y: 80, width: 240, height: 140},
        mode: 'copy',
    };
    const presenter = {
        blackboardClipboard: {...copiedSelection},
        workspace: {activeBoardId: 'target-board'},
        blackboard: {boardId: 'target-board', widgets: []},
        boardCache: new Map(),
        filmstripOpen: false,
        busy: false,
        adapter: {async sendWorkspaceAction(action, input) { calls.push({action, input}); }},
        canPasteBlackboardSelection(target) {
            return blackboardWorkspaceMethods.canPasteBlackboardSelection.call(this, target);
        },
        pasteBlackboardClipboardAt(input) {
            return blackboardWorkspaceMethods.pasteBlackboardClipboardAt.call(this, input);
        },
    };
    await blackboardWorkspaceMethods.pasteBlackboardSelection.call(presenter, null);
    assert.deepEqual(calls[0], {
        action: 'board-copy',
        input: {
            boardId: 'source-board', targetBoardId: 'target-board', widgetIds: ['a', 'b'],
            placement: {x: 124, y: 104},
        },
    });
    assert.equal(presenter.blackboardClipboard, null);

    presenter.blackboardClipboard = {...copiedSelection};
    presenter.filmstripOpen = true;
    presenter.workspaceFilmstripTrack = {};
    presenter.loadWorkspaceFilmstrip = async () => {};
    const card = {dataset: {boardId: 'filmstrip-target'}};
    await blackboardWorkspaceMethods.pasteBlackboardSelection.call(presenter, {closest: () => card});
    assert.equal(calls[1].input.targetBoardId, 'filmstrip-target');
    assert.deepEqual(calls[1].input.placement, {x: 124, y: 104});
    assert.equal(presenter.blackboardClipboard, null);
});

test('context menu cut uses transfer and paste-here preserves the exact context position', async () => {
    const calls = [];
    const board = {boardId: 'source-board', widgets: [
        {id: 'a', type: 'shape', properties: {geometry: {x: 40, y: 60, width: 100, height: 60}}},
        {id: 'b', type: 'shape', properties: {geometry: {x: 180, y: 60, width: 100, height: 60}}},
    ]};
    const presenter = {
        selectionContextState: {
            sourceBoardId: 'source-board', sourceBoard: board, widgetIds: ['a', 'b'],
        },
        blackboardClipboard: null,
        boardCache: new Map(),
        filmstripOpen: false,
        busy: false,
        canMoveWidget: () => true,
        closeSelectionContextMenu() { this.selectionContextState = null; },
        setBlackboardClipboard(input) {
            return blackboardWorkspaceMethods.setBlackboardClipboard.call(this, input);
        },
        pasteBlackboardClipboardAt(input) {
            return blackboardWorkspaceMethods.pasteBlackboardClipboardAt.call(this, input);
        },
        adapter: {async sendWorkspaceAction(action, input) { calls.push({action, input}); }},
    };
    blackboardWorkspaceMethods.cutContextSelection.call(presenter);
    assert.equal(presenter.blackboardClipboard.mode, 'cut');

    presenter.selectionContextState = {targetBoardId: 'target-board', placement: {x: 415, y: 275}};
    await blackboardWorkspaceMethods.pasteContextSelectionHere.call(presenter);
    assert.deepEqual(calls, [{
        action: 'board-transfer',
        input: {
            boardId: 'source-board', targetBoardId: 'target-board', widgetIds: ['a', 'b'],
            placement: {x: 415, y: 275},
        },
    }]);
    assert.equal(presenter.blackboardClipboard, null);
});

test('filmstrip drop sends the computed placement through the canonical transfer action', async () => {
    const calls = [];
    const preview = {
        dataset: { logicalWidth: '1200', logicalHeight: '800' },
        getBoundingClientRect: () => ({left: 100, top: 50, width: 300, height: 200}),
    };
    const card = {
        dataset: { boardId: 'target-board' },
        querySelector: () => preview,
    };
    const presenter = {
        filmstripDragState: {
            sourceBoardId: 'source-board',
            widgetIds: ['a', 'b'],
            node: {classList: {remove() {}}},
            sourceBounds: {x: 100, y: 80, width: 240, height: 140},
            grabOffset: {x: 60, y: 35},
        },
        workspaceFilmstripTrack: {querySelectorAll: () => []},
        boardCache: new Map([['source-board', {}], ['target-board', {}]]),
        adapter: {async sendWorkspaceAction(action, input) { calls.push({action, input}); }},
        filmstripOpen: false,
        handleFilmstripDragEnd() {
            return blackboardWorkspaceMethods.handleFilmstripDragEnd.call(this);
        },
    };
    await blackboardWorkspaceMethods.handleFilmstripDrop.call(presenter, {
        clientX: 250,
        clientY: 150,
        target: {closest: () => card},
        preventDefault() {},
    });
    assert.deepEqual(calls, [{
        action: 'board-transfer',
        input: {
            boardId: 'source-board',
            targetBoardId: 'target-board',
            widgetIds: ['a', 'b'],
            placement: {x: 540, y: 365},
        },
    }]);
});

test('filmstrip accepts a drop back onto the source workspace', async () => {
    const calls = [];
    const preview = {
        dataset: { logicalWidth: '1200', logicalHeight: '800' },
        getBoundingClientRect: () => ({left: 0, top: 0, width: 300, height: 200}),
    };
    const card = {dataset: {boardId: 'same-board'}, querySelector: () => preview};
    const presenter = {
        filmstripDragState: {
            sourceBoardId: 'same-board', widgetIds: ['a'], node: {classList: {remove() {}}},
            sourceBounds: {x: 100, y: 80, width: 100, height: 60}, grabOffset: {x: 50, y: 30},
        },
        workspaceFilmstripTrack: {querySelectorAll: () => []},
        boardCache: new Map([['same-board', {}]]),
        adapter: {async sendWorkspaceAction(action, input) { calls.push({action, input}); }},
        filmstripOpen: false,
        handleFilmstripDragEnd() { return blackboardWorkspaceMethods.handleFilmstripDragEnd.call(this); },
    };
    await blackboardWorkspaceMethods.handleFilmstripDrop.call(presenter, {
        clientX: 150, clientY: 100, target: {closest: () => card}, preventDefault() {},
    });
    assert.deepEqual(calls[0], {
        action: 'board-transfer',
        input: {
            boardId: 'same-board', targetBoardId: 'same-board', widgetIds: ['a'], placement: {x: 550, y: 370},
        },
    });
});

test('filmstrip view projects real widget content instead of generic placeholders', () => {
    assert.deepEqual(getFilmstripWidgetView({
        type: 'card',
        properties: { title: 'Architecture', text: 'API boundary', style: { fill: '#fff', stroke: '#123' } },
    }), {
        type: 'card', kicker: '', title: 'Architecture', body: 'API boundary', items: [],
        imageUrl: '', imageAlt: '', shapeKind: 'rectangle', fill: '#fff', stroke: '#123', textColor: '',
    });
    assert.deepEqual(getFilmstripWidgetView({
        type: 'bullets',
        properties: { title: 'Actions', items: [{ text: 'Ship it' }, { text: 'Verify it' }] },
    }).items, ['Ship it', 'Verify it']);
    assert.deepEqual(getFilmstripWidgetView({
        type: 'scripta-document',
        properties: { documentTitle: 'Draft', chapters: [{ chapterTitle: 'Introduction' }] },
    }).items, ['Introduction']);
    assert.equal(getFilmstripWidgetView({
        type: 'image', properties: { source: { url: '/workspace-files/image.png', name: 'Diagram' } },
    }).imageUrl, '/workspace-files/image.png');
    assert.deepEqual(getFilmstripWidgetView({
        type: 'file', properties: { source: { name: 'agenda.pdf', extension: 'pdf', mimeType: 'application/pdf', size: 4096 } },
    }), {
        type: 'file', kicker: 'PDF', title: 'agenda.pdf', body: 'application/pdf · 4.0 KB', items: [],
        imageUrl: '', imageAlt: '', shapeKind: 'rectangle', fill: '', stroke: '', textColor: '',
    });
});

test('filmstrip external file drop publishes at the exact target workspace position', async () => {
    const calls = [];
    const card = {
        dataset: {boardId: 'board-target'},
        classList: {remove() {}},
        querySelector: () => ({
            dataset: {logicalWidth: '1200', logicalHeight: '800'},
            getBoundingClientRect: () => ({left: 100, top: 50, width: 300, height: 200}),
        }),
    };
    const file = {name: 'agenda.pdf'};
    const presenter = {
        filmstripDragState: null,
        hasTransferredFiles: () => true,
        getTransferredFiles: () => [file],
        publishTransferredFiles: (files, options) => calls.push({files, options}),
    };
    let prevented = 0;
    let stopped = 0;
    await blackboardWorkspaceMethods.handleFilmstripDrop.call(presenter, {
        target: {closest: () => card},
        dataTransfer: {files: [file]},
        clientX: 250,
        clientY: 150,
        preventDefault: () => { prevented += 1; },
        stopPropagation: () => { stopped += 1; },
    });
    assert.equal(prevented, 1);
    assert.equal(stopped, 1);
    assert.deepEqual(calls, [{
        files: [file],
        options: {boardId: 'board-target', position: {x: 600, y: 400}},
    }]);
});

test('normal Blackboard drop and paste emit the shared attachment publication event', () => {
    const PreviousCustomEvent = globalThis.CustomEvent;
    const PreviousElement = globalThis.Element;
    class TestElement {
        closest() { return null; }
    }
    globalThis.CustomEvent = class {
        constructor(type, options = {}) {
            this.type = type;
            Object.assign(this, options);
        }
    };
    globalThis.Element = TestElement;
    const emitted = [];
    const target = new TestElement();
    const presenter = Object.create(WebMeetBlackboardPanel.prototype);
    Object.assign(presenter, {
        workspace: {activeBoardId: 'board-active'},
        element: {
            contains: (candidate) => candidate === target,
            dispatchEvent: (event) => emitted.push(event),
        },
        board: {getBoundingClientRect: () => ({left: 10, top: 20, width: 600, height: 400})},
        fileDropOverlay: {hidden: false, setAttribute() {}},
        fileDragDepth: 1,
        getBoardPointFromEvent: (event) => ({x: event.clientX - 10, y: event.clientY - 20}),
    });
    const dropped = {name: 'drop.pdf'};
    const pasted = {name: 'paste.docx'};
    try {
        let dropPrevented = 0;
        presenter.handleBoardFileDrop({
            dataTransfer: {files: [dropped]},
            clientX: 210,
            clientY: 170,
            preventDefault: () => { dropPrevented += 1; },
            stopPropagation() {},
        });
        assert.equal(dropPrevented, 1);
        assert.deepEqual(emitted[0].detail, {
            files: [dropped], boardId: 'board-active', position: {x: 200, y: 150},
        });

        let pastePrevented = 0;
        presenter.handlePanelPaste({
            defaultPrevented: false,
            target,
            clipboardData: {files: [pasted]},
            preventDefault: () => { pastePrevented += 1; },
            stopPropagation() {},
        });
        assert.equal(pastePrevented, 1);
        assert.deepEqual(emitted[1].detail, {
            files: [pasted], boardId: 'board-active', position: {x: 300, y: 200},
        });
        assert.ok(emitted.every((event) => event.type === 'webmeet-blackboard-attachment-upload'));
    } finally {
        if (PreviousCustomEvent === undefined) delete globalThis.CustomEvent;
        else globalThis.CustomEvent = PreviousCustomEvent;
        if (PreviousElement === undefined) delete globalThis.Element;
        else globalThis.Element = PreviousElement;
    }
});

test('filmstrip drag resolves a widget, its rigid group, or the active multi-selection', () => {
    const board = {
        widgets: [
            { id: 'shape-a', type: 'shape', groupId: 'group-1' },
            { id: 'shape-b', type: 'shape', groupId: 'group-1' },
            { id: 'card-c', type: 'card' },
            { id: 'image-d', type: 'image' },
            {
                id: 'line-e', type: 'line',
                properties: {connection: {from: {widgetId: 'card-c'}, to: {widgetId: 'image-d'}}},
            },
        ],
    };
    assert.deepEqual(resolveFilmstripTransferWidgetIds(board, 'shape-a'), ['shape-a', 'shape-b']);
    assert.deepEqual(
        resolveFilmstripTransferWidgetIds(board, 'shape-a', new Set(['shape-a', 'card-c'])),
        ['shape-a', 'shape-b', 'card-c'],
    );
    assert.deepEqual(resolveFilmstripTransferWidgetIds(board, 'line-e'), ['card-c', 'image-d', 'line-e']);
    assert.deepEqual(
        resolveFilmstripTransferWidgetIds(board, 'card-c', new Set(['card-c', 'image-d'])),
        ['card-c', 'image-d', 'line-e'],
    );
    assert.deepEqual(resolveFilmstripTransferWidgetIds(board, 'image-d'), ['image-d']);
    assert.deepEqual(resolveFilmstripTransferWidgetIds(board, 'missing'), []);
});

test('tab rename exits immediately and persists only a changed title', async () => {
    const calls = [];
    const presenter = {
        renamingWorkspaceBoardId: 'board-1',
        workspace: { boards: [{ boardId: 'board-1', title: 'Document' }] },
        renderCount: 0,
        renderWorkspaceTabs() { this.renderCount += 1; },
        adapter: { async sendWorkspaceAction(action, input) { calls.push({ action, input }); } },
    };
    await blackboardWorkspaceMethods.commitWorkspaceBoardRename.call(presenter, {
        dataset: { boardId: 'board-1' }, value: 'Architecture',
    });
    assert.equal(presenter.renamingWorkspaceBoardId, '');
    assert.equal(presenter.renderCount, 1);
    assert.deepEqual(calls, [{
        action: 'board-rename', input: { boardId: 'board-1', title: 'Architecture' },
    }]);

    presenter.renamingWorkspaceBoardId = 'board-1';
    await blackboardWorkspaceMethods.commitWorkspaceBoardRename.call(presenter, {
        dataset: { boardId: 'board-1' }, value: 'Document',
    });
    assert.equal(presenter.renderCount, 2);
    assert.equal(calls.length, 1);
});
