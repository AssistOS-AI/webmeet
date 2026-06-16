import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    Blackboard,
    BlackboardWidget,
    createBlackboardWidget
} from '../../lib/blackboard/model.mjs';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    parseWebMeetEvent
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/webmeet-events.js';
import {
    applyRoomBlackboardChange,
    createMeeting,
    createStoreContext,
    getRoomBlackboard,
    joinMeeting,
    listMeetingEvents
} from '../../lib/webmeetStore.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord
} from '../../lib/store/roomRecords.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import {
    encodeBlackboardProtocolMessage,
    parseBlackboardProtocolMessage
} from '../../lib/blackboard/protocol.mjs';
import { BlackboardNetworkAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/blackboard/blackboard-network-adapter.js';

const BLACKBOARD_PANEL_MODULES = [
    'webmeet-blackboard-panel.js',
    'webmeet-blackboard-actions.js',
    'webmeet-blackboard-geometry.js',
    'webmeet-blackboard-interactions.js',
    'webmeet-blackboard-rendering.js'
];

async function readBlackboardPanelSource() {
    const panelDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components/webmeet-blackboard-panel'
    );
    const sources = await Promise.all(
        BLACKBOARD_PANEL_MODULES.map((fileName) => fs.readFile(path.join(panelDir, fileName), 'utf8'))
    );
    return sources.join('\n');
}

test('blackboard applies final create, patch and delete operations', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        widget: createBlackboardWidget('shape', {
            geometry: { x: 10, y: 20, width: 100, height: 50 }
        }, { id: 'shape_1' }).serializePrivileged()
    });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'shape_1',
        reason: 'drag',
        patch: { properties: { geometry: { x: 40 } } }
    });

    assert.equal(blackboard.getWidget('shape_1').properties.geometry.x, 40);
    assert.equal(blackboard.getWidget('shape_1').properties.geometry.y, 20);

    blackboard.applyFinalChange({
        changeType: 'delete',
        targetType: 'widget',
        targetRef: 'shape_1'
    });

    assert.equal(blackboard.getWidget('shape_1'), null);
});

test('blackboard applies final background changes to board metadata', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'blackboard',
        reason: 'background',
        patch: {
            metadata: {
                background: {
                    color: '#f8fafc',
                    gridColor: '#dbe4ef',
                    gridSize: 20
                }
            }
        }
    });

    assert.deepEqual(blackboard.serialize().metadata.background, {
        color: '#f8fafc',
        gridColor: '#dbe4ef',
        gridSize: 20
    });
    assert.equal(blackboard.version, 1);
});

test('blackboard filters participant data for normal participants and exposes it to moderators', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'quiz_1',
        type: 'quiz',
        properties: {
            prompt: '2 + 2',
            correctAnswer: '4',
            participantData: {
                alice: { answer: '4' },
                bob: { answer: '5' }
            },
            aggregation: { counts: { 4: 1, 5: 1 } },
            resultsVisibility: 'moderators'
        }
    }));

    const alice = blackboard.serialize({ participantId: 'alice', roles: [] });
    const moderator = blackboard.serialize({ participantId: 'mod', roles: ['moderator'] });

    assert.deepEqual(alice.widgets[0].properties.participantData, { alice: { answer: '4' } });
    assert.equal(alice.widgets[0].properties.aggregation, undefined);
    assert.equal(alice.widgets[0].properties.correctAnswer, undefined);
    assert.deepEqual(moderator.widgets[0].properties.participantData, {
        alice: { answer: '4' },
        bob: { answer: '5' }
    });
    assert.deepEqual(moderator.widgets[0].properties.aggregation, { counts: { 4: 1, 5: 1 } });
});

test('blackboard supports document visibility and results visibility variants', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'vote_1',
        type: 'vote',
        visibility: 'user:alice',
        properties: {
            question: 'Pick',
            participantData: {
                alice: { vote: 'A' },
                bob: { vote: 'B' }
            },
            aggregation: { counts: { A: 1, B: 1 } },
            resultsVisibility: 'afterVote',
            anonymous: true
        }
    }));

    const alice = blackboard.serialize({ participantId: 'alice', roles: [] });
    const bob = blackboard.serialize({ participantId: 'bob', roles: [] });
    const moderator = blackboard.serialize({ participantId: 'mod', roles: ['moderator'] });

    assert.equal(alice.widgets.length, 1);
    assert.deepEqual(alice.widgets[0].properties.participantData, {});
    assert.deepEqual(alice.widgets[0].properties.aggregation, { counts: { A: 1, B: 1 } });
    assert.equal(bob.widgets.length, 0);
    assert.equal(moderator.widgets.length, 1);
});

test('blackboard undo and redo keep a bounded final-operation history', () => {
    const blackboard = new Blackboard({ roomId: 'room_1', maxHistoryDepth: 3 });
    blackboard.addWidget(createBlackboardWidget('text', { text: 'a' }, { id: 'text_1' }));
    blackboard.patchWidget('text_1', { properties: { text: 'b' } });
    blackboard.patchWidget('text_1', { properties: { text: 'c' } });
    blackboard.patchWidget('text_1', { properties: { text: 'd' } });

    assert.equal(blackboard.history.undoStack.length, 3);
    blackboard.undo();
    assert.equal(blackboard.getWidget('text_1').properties.text, 'c');
    blackboard.redo();
    assert.equal(blackboard.getWidget('text_1').properties.text, 'd');
});

test('blackboard.updated uses the canonical WebMeet event format', () => {
    const encoded = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        blackboardVersion: 7,
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'shape_1',
        objectKind: 'widget'
    });
    const parsed = parseWebMeetEvent(encoded);

    assert.equal(parsed.room, 'room_1');
    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(parsed.payload.blackboardVersion, 7);
});

test('blackboard protocol serializes final filtered objects with actor addresses', () => {
    const encoded = encodeBlackboardProtocolMessage({
        from: 'user:participant_1',
        to: 'ALL',
        payload: {
            kind: 'widget',
            roomId: 'room_1',
            version: 3,
            visibility: { mode: 'all' },
            object: { id: 'widget_1', version: 3 }
        }
    });
    const parsed = parseBlackboardProtocolMessage(encoded);

    assert.match(encoded, /^blackboard:user:participant_1:ALL:/);
    assert.equal(parsed.from, 'user:participant_1');
    assert.equal(parsed.to, 'ALL');
    assert.equal(parsed.payload.kind, 'widget');
    assert.equal(parsed.payload.object.id, 'widget_1');
});

test('blackboard network adapter deduplicates and applies final protocol objects without resync', async () => {
    let resyncCount = 0;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        participantId: 'participant_1',
        runTool: async () => {
            resyncCount += 1;
            return { blackboard: { roomId: 'room_1', version: 1, widgets: [] } };
        }
    });
    const received = [];
    adapter.subscribe((payload) => received.push(payload));
    const blackboardMessage = encodeBlackboardProtocolMessage({
        from: 'service:webmeetAgent',
        to: 'ALL',
        payload: {
            kind: 'widget',
            roomId: 'room_1',
            messageId: 'bb_msg_1',
            version: 4,
            visibility: { mode: 'all' },
            object: { id: 'widget_1', type: 'text', version: 4, properties: { text: 'Done' } }
        }
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        blackboardVersion: 4,
        changeType: 'update',
        objectKind: 'widget',
        blackboardMessage
    });

    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'duplicate');
    assert.equal(resyncCount, 0);
    assert.equal(received[0].kind, 'widget');
    assert.equal(received[0].object.properties.text, 'Done');
});

test('blackboard UI editing does not use browser prompt dialogs', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components'
    );
    const source = await readBlackboardPanelSource();
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const combinedSource = `${source}\n${toolbarSource}\n${editorSource}`;

    assert.doesNotMatch(combinedSource, /window\.prompt|prompt\(|alert\(/);
    assert.doesNotMatch(combinedSource, /customElements\.define|extends HTMLElement|shadowRoot|innerHTML/);
    assert.doesNotMatch(source, /webSkel\.defineComponent|BLACKBOARD_COMPONENT_DEFINITIONS|upsertWebSkelComponent/);
    assert.match(source, /contentEditable = 'true'/);
    assert.match(source, /widget\.type === 'text' \|\| widget\.type === 'card'/);
    assert.match(source, /addEventListener\('focusin'/);
    assert.match(source, /addEventListener\('blur'/);
    assert.match(source, /getEditableWidgetProperty/);
    assert.match(source, /\[property\]: nextText/);
    assert.match(source, /return 'text'/);
    assert.doesNotMatch(source, /widget\?\.type === 'card' \? 'label' : 'text'/);
    assert.match(source, /webmeet-blackboard-toolbar/);
    assert.match(editorSource, /blackboard-editor-save/);
});

test('RoboTeam card widgets persist inline edits into the canonical text property', async () => {
    const source = await readBlackboardPanelSource();
    const editableTextMethod = source.slice(
        source.indexOf('    getEditableWidgetText(widget)'),
        source.indexOf('\n    startInlineTextEdit(widget)', source.indexOf('    getEditableWidgetText(widget)'))
    );
    const roboTeamSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../lib/roboTeam/service.mjs'),
        'utf8'
    );

    assert.match(roboTeamSource, /id: 'robo_demo_context'[\s\S]*type: 'card'[\s\S]*text:/);
    assert.match(source, /widget\.type === 'card'[\s\S]*webmeet-blackboard-widget-title/);
    assert.match(source, /patch:\s*\{\s*properties:\s*\{\s*\[property\]:\s*nextText\s*\}\s*\}/);
    assert.match(source, /getEditableWidgetProperty\(\) \{[\s\S]*return 'text';[\s\S]*\}/);
    assert.doesNotMatch(editableTextMethod, /label/);
});

test('blackboard realtime widget updates refresh the rendered panel', async () => {
    const panelSource = await readBlackboardPanelSource();
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/blackboard-methods.js'),
        'utf8'
    );

    assert.match(panelSource, /this\.handleUpdateEvent = \(event\) => this\.applyBlackboardUpdate\(event\.detail \|\| \{\}\)/);
    assert.match(panelSource, /applyBlackboardUpdate\(detail = \{\}\)[\s\S]*detail\?\.widget[\s\S]*this\.applyWidgetObject\(detail\.widget\)/);
    assert.match(panelSource, /adapter && adapter !== this\.adapter[\s\S]*this\.unsubscribeAdapter\?\.\(\)/);
    assert.match(controllerSource, /payload\.kind === 'widget'[\s\S]*webmeet-blackboard-update[\s\S]*widget: payload\.object/);
});

test('blackboard panel addWidget uses connected adapter', async () => {
    const { WebMeetBlackboardPanel } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components/webmeet-blackboard-panel/webmeet-blackboard-panel.js')
    );
    const sentChanges = [];
    const listeners = new Map();
    const dispatchedEvents = [];
    const element = {
        querySelector(selector) {
            if (selector === '[data-role="board"]') {
                return {
                    style: { setProperty() {} },
                    replaceChildren() {}
                };
            }
            return null;
        },
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        removeEventListener(type, handler) {
            if (listeners.get(type) === handler) {
                listeners.delete(type);
            }
        },
        dispatchEvent(event) {
            dispatchedEvents.push(event.type);
            return true;
        }
    };
    const panel = new WebMeetBlackboardPanel(element, () => {});
    panel.renderWidgets = () => {};
    panel.updateToolbarState = () => {};
    const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (callback) => {
        callback();
        return 1;
    };
    panel.afterRender();
    if (previousRequestAnimationFrame === undefined) {
        delete globalThis.requestAnimationFrame;
    } else {
        globalThis.requestAnimationFrame = previousRequestAnimationFrame;
    }
    assert.ok(dispatchedEvents.includes('webmeet-blackboard-panel-ready'));
    listeners.get('webmeet-blackboard-connect')?.({
        detail: {
            adapter: {
                subscribe() {
                    return () => {};
                },
                async sendChange(change) {
                    sentChanges.push(change);
                    return {
                        object: change.widget,
                        blackboard: { roomId: 'room_1', version: 2, widgets: [change.widget] }
                    };
                }
            },
            blackboard: { roomId: 'room_1', version: 1, widgets: [] }
        }
    });

    await panel.addWidget('shape:ellipse');

    assert.equal(sentChanges.length, 1);
    assert.equal(sentChanges[0].changeType, 'create');
    assert.equal(sentChanges[0].widget.type, 'shape');
    assert.equal(sentChanges[0].widget.properties.shapeKind, 'ellipse');
});

test('blackboard opens as the focused item inside the participant video layout', async () => {
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const participantSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/participant-view-methods.js'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.css'),
        'utf8'
    );

    assert.match(controllerSource, /applyBlackboardFocusLayout\(\)/);
    assert.match(controllerSource, /this\.videoGridAll\.prepend\(this\.blackboardSurface\)/);
    assert.match(controllerSource, /this\.videoGridAll\.classList\.add\('has-focus'\)/);
    assert.match(controllerSource, /view\.isMini = true/);
    assert.match(participantSource, /this\.applyBlackboardFocusLayout\?\.\(\)/);
    assert.match(dashboardCss, /\.webmeet-video-all\.has-focus \.webmeet-blackboard-surface\.is-focused/);
    assert.match(dashboardCss, /width: clamp\(240px, calc\(100% - 92px\), 100%\)/);
});

test('blackboard widgets support final resize changes for shape line card and text', async () => {
    const source = await readBlackboardPanelSource();
    const css = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components/webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.match(source, /canResizeWidget\(widget\)[\s\S]*\['shape', 'line', 'card', 'text'\]\.includes/);
    assert.match(source, /renderResizeHandles\(node, widget\)/);
    assert.match(source, /data-resize-handle/);
    assert.match(source, /reason: 'resize'/);
    assert.match(source, /\.\.\.geometry/);
    assert.match(source, /event\.target\?\.closest\?\.\('\[data-resize-handle\]'\)/);
    assert.match(css, /\.webmeet-blackboard-resize-handle/);
    assert.match(css, /\.webmeet-blackboard-widget\[aria-selected="true"\] \.webmeet-blackboard-resize-handle/);
});

test('blackboard supports shape variants angled lines and arrows', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const editorHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.html'),
        'utf8'
    );

    assert.match(toolbarHtml, /data-local-action="addWidget shape:ellipse"/);
    assert.match(toolbarHtml, /data-local-action="addWidget shape:diamond"/);
    assert.match(toolbarHtml, /data-local-action="addWidget line:arrow-end"/);
    assert.match(toolbarHtml, /data-local-action="addWidget line:arrow-both"/);
    assert.doesNotMatch(toolbarHtml, /data-widget-type=/);
    assert.match(panelSource, /createShapeSvg\(widget\)/);
    assert.match(panelSource, /shapeKind === 'triangle'/);
    assert.match(panelSource, /createLineSvg\(widget\)/);
    assert.match(panelSource, /marker-end/);
    assert.match(panelSource, /marker-start/);
    assert.match(panelSource, /widget\.properties\.line = \{/);
    assert.match(panelSource, /nextProperties\.line = \{/);
    assert.match(panelSource, /getLineAngle\(line = \{\}\)/);
    assert.match(panelSource, /getLineEndpoints\(width, height, angle\)/);
    assert.match(panelSource, /angle,\s*\.\.\.this\.getLineEndpoints\(220, 80, angle\)/);
    assert.match(panelSource, /dataResizeHandle = handle\.name|dataset\.resizeHandle = handle\.name/);
    assert.match(panelSource, /line-start/);
    assert.match(panelSource, /line-end/);
    assert.match(panelSource, /getLineEndpointResize\(state, event\)/);
    assert.match(panelSource, /movingEndpoint: handle === 'line-start' \? 'start' : 'end'/);
    assert.match(panelCss, /\.webmeet-blackboard-line-svg/);
    assert.match(panelCss, /\.webmeet-blackboard-resize-handle\.line-endpoint/);
    assert.match(editorHtml, /data-role="shapeKind"/);
    assert.match(editorHtml, /data-role="lineMarker"/);
    assert.doesNotMatch(editorHtml, /data-role="lineAngle"/);
    assert.match(editorSource, /patch\.properties\.shapeKind/);
    assert.match(editorSource, /patch\.properties\.line/);
    assert.doesNotMatch(editorSource, /lineAngleInput/);
});

test('blackboard toolbar updates persisted board background metadata', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components'
    );
    const panelSource = await readBlackboardPanelSource();
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.match(toolbarHtml, /data-background-color/);
    assert.match(toolbarSource, /blackboard-background/);
    assert.match(toolbarHtml, /data-local-action="setTool select"/);
    assert.match(toolbarHtml, /data-local-action="runToolbarAction delete"/);
    assert.doesNotMatch(toolbarHtml, /data-action=/);
    assert.match(toolbarSource, /setTool\(_target, tool = 'select'\)/);
    assert.match(toolbarSource, /addWidget\(_target, type = 'shape'\)/);
    assert.match(toolbarSource, /runToolbarAction\(_target, action = ''\)/);
    assert.match(toolbarSource, /constructor\(element, invalidate\)/);
    assert.doesNotMatch(toolbarSource, /registerAction/);
    assert.doesNotMatch(toolbarSource, /addEventListener\('click'/);
    assert.doesNotMatch(toolbarSource, /handleToolbarClick/);
    assert.match(panelSource, /setBlackboardBackground\(background = \{\}\)/);
    assert.match(panelSource, /targetType: 'blackboard'/);
    assert.match(panelSource, /metadata: \{[\s\S]*background:/);
    assert.match(panelSource, /applyBoardBackground\(\)/);
    assert.match(panelCss, /--blackboard-background-color/);
});

test('blackboard components are declared in WebMeet registries', async () => {
    const config = JSON.parse(await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    ));
    const roomLoader = await fs.readFile(
        path.resolve(import.meta.dirname, '../../static-files/roomLoader.js'),
        'utf8'
    );
    const dependencyNames = new Set((config.dependencies || []).map((entry) => entry.component));
    assert.match(roomLoader, /PLUGIN_CONFIG_URL/);
    assert.match(roomLoader, /loadComponentDefinitions/);
    assert.doesNotMatch(roomLoader, /const componentDefinitions = \[/);
    for (const componentName of [
        'webmeet-blackboard-panel',
        'webmeet-blackboard-toolbar',
        'webmeet-blackboard-widget-editor',
        'webmeet-blackboard-results-panel'
    ]) {
        const dependency = (config.dependencies || []).find((entry) => entry.component === componentName);
        assert.ok(dependencyNames.has(componentName), `${componentName} missing from plugin config dependencies`);
        assert.ok(dependency?.path, `${componentName} must declare its nested component path`);
        for (const extension of ['html', 'css', 'js']) {
            const assetPath = path.resolve(import.meta.dirname, `../../IDE-plugins/webmeet-tool-button/${dependency.path}.${extension}`);
            await fs.access(assetPath);
        }
    }
});

test('blackboard panel is a static WebSkel child driven through DOM events', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const panelSource = await readBlackboardPanelSource();
    const parentSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );
    const dashboardHtml = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.html'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.js'),
        'utf8'
    );

    assert.match(dashboardHtml, /<webmeet-blackboard-panel data-presenter="webmeet-blackboard-panel"><\/webmeet-blackboard-panel>/);
    assert.doesNotMatch(source, /webSkel\.createElement/);
    assert.doesNotMatch(source, /waitForBlackboardPanelReady/);
    assert.doesNotMatch(source, /ensureBlackboardPanel/);
    assert.doesNotMatch(source, /ensureBlackboardComponentsRegistered/);
    assert.doesNotMatch(source, /requestAnimationFrame/);
    assert.doesNotMatch(source, /\.configure\(/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-blackboard-toolbar'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-blackboard-widget-editor'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-blackboard-results-panel'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-blackboard-panel'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-settings-modal'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-room-settings-modal'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('webmeet-participant-audio-modal'\)/);
    assert.match(parentSource, /ensureComponentRegistered\('create-room-modal'\)/);
    assert.match(dashboardSource, /async beforeRender\(\)[\s\S]*ensureAvatarSettingsFormRegistered/);
    assert.doesNotMatch(dashboardSource, /await this\.bootstrap\(\)/);
    assert.match(source, /webmeet-blackboard-connect/);
    assert.match(source, /webmeet-blackboard-update/);
    assert.match(source, /webmeet-blackboard-disconnect/);
    assert.match(panelSource, /handleToolbarAddWidgetEvent/);
    assert.match(panelSource, /removeEventListener\('blackboard-add-widget', this\.handleToolbarAddWidgetEvent\)/);
    assert.doesNotMatch(panelSource, /connectBlackboard/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-connect'/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-update'/);
    assert.match(panelSource, /addEventListener\('webmeet-blackboard-disconnect'/);
    assert.doesNotMatch(source, /this\.blackboardSurface\?\.querySelector\('webmeet-blackboard-panel'\)/);
    assert.match(source, /const panel = this\.blackboardPanel/);
});

test('blackboard WebSkel components trigger their initial render', async () => {
    for (const componentName of [
        'webmeet-blackboard-panel',
        'webmeet-blackboard-toolbar',
        'webmeet-blackboard-widget-editor',
        'webmeet-blackboard-results-panel'
    ]) {
        const source = await fs.readFile(
            path.resolve(
                import.meta.dirname,
                `../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/components/${componentName}/${componentName}.js`
            ),
            'utf8'
        );
        assert.match(source, /constructor\(element,\s*invalidate(?:,\s*hostContext)?\)/, `${componentName} must accept WebSkel invalidate`);
        assert.match(source, /this\.invalidate = invalidate/, `${componentName} must store WebSkel invalidate`);
        assert.match(source, /beforeRender\(\)\s*\{\}/, `${componentName} must implement WebSkel beforeRender`);
        assert.match(source, /this\.invalidate\(\)/, `${componentName} must trigger its initial WebSkel render`);
    }
});

test('blackboard visibility change is a realtime-only WebMeet event', () => {
    const encoded = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED, {
        meetingId: 'room_1',
        participantId: 'participant_1',
        visible: true
    });
    const parsed = parseWebMeetEvent(encoded);

    assert.equal(parsed.type, WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED);
    assert.equal(parsed.payload.visible, true);
    assert.equal(parsed.persistent, false);
});

test('webmeet store persists blackboard on the RoboTeam agent and appends final event', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.ploinky', 'webmeet');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const context = await createStoreContext(root);
        const meeting = await createMeeting(context, { name: 'Blackboard test', authInfo });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            authInfo,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'shape_1',
                    type: 'shape',
                    properties: { geometry: { x: 1, y: 2, width: 100, height: 50 } }
                }
            }
        });

        const response = await getRoomBlackboard(context, { roomId: meeting.roomId, authInfo });
        const events = await listMeetingEvents(context, meeting.roomId);
        const record = await loadRoomRecord(context, meeting.roomId);
        const payload = decryptRoomPayload(context, record);
        const roboTeam = payload.agents.find((agent) => agent.id === 'agent_robo_team');

        assert.ok(response.blackboard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.equal(payload.blackboard, undefined);
        assert.ok(roboTeam.blackboard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.ok(events.some((event) => parseWebMeetEvent(event).type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED));
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet blackboard tool decodes serialized final change objects from transport', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-tool-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    try {
        process.env.WEBMEET_DATA_DIR = path.join(root, 'data');
        process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
        const context = await createStoreContext(root);
        const authInfo = {
            user: {
                id: 'local:admin',
                username: 'admin',
                roles: ['admin']
            }
        };
        const meeting = await createMeeting(context, {
            workspaceId: 'rooms',
            title: 'Serialized blackboard tool room',
            authInfo
        });
        await dispatch('webmeet_blackboard_apply', {
            roomId: meeting.roomId,
            participantId: 'participant-admin',
            change: JSON.stringify({
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'card_1',
                    type: 'card',
                    properties: {
                        text: 'Initial',
                        geometry: { x: 1, y: 2, width: 100, height: 50 }
                    }
                }
            })
        }, context, authInfo);

        const response = await dispatch('webmeet_blackboard_apply', {
            roomId: meeting.roomId,
            participantId: 'participant-admin',
            change: JSON.stringify({
                changeType: 'update',
                targetType: 'widget',
                targetRef: 'card_1',
                reason: 'edit',
                patch: { properties: { text: 'Updated' } }
            })
        }, context, authInfo);

        const widget = response.blackboard.widgets.find((entry) => entry.id === 'card_1');
        assert.equal(widget.properties.text, 'Updated');
        assert.equal(response.change.changeType, 'update');
        assert.equal(response.broadcast.version, response.blackboard.version);
        assert.equal(response.broadcast.ownerParticipantId, 'agent_robo_team');
        assert.equal(response.broadcast.blackboardId, response.blackboard.id);
        assert.notEqual(response.broadcast.version, response.object.version);

        const backgroundResponse = await dispatch('webmeet_blackboard_apply', {
            roomId: meeting.roomId,
            participantId: 'participant-admin',
            change: JSON.stringify({
                changeType: 'update',
                targetType: 'blackboard',
                reason: 'background',
                patch: { metadata: { background: { color: '#f8fafc' } } }
            })
        }, context, authInfo);

        assert.equal(backgroundResponse.blackboard.metadata.background.color, '#f8fafc');
        assert.equal(backgroundResponse.object.metadata.background.color, '#f8fafc');
        assert.equal(backgroundResponse.broadcast.kind, 'blackboard');
        assert.equal(backgroundResponse.broadcast.object.metadata.background.color, '#f8fafc');
    } finally {
        if (previousDataDir === undefined) {
            delete process.env.WEBMEET_DATA_DIR;
        } else {
            process.env.WEBMEET_DATA_DIR = previousDataDir;
        }
        if (previousMasterKey === undefined) {
            delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        } else {
            process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        }
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet blackboard submit derives participant authority from joined participant, not client change data', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-spoof-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.ploinky', 'webmeet');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const userAuth = { user: { id: 'local:user-1', username: 'user1', roles: ['user'] } };
        const context = await createStoreContext(root);
        const meeting = await createMeeting(context, { name: 'Blackboard spoof test', authInfo: adminAuth });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            participantId: 'participant_user_1',
            displayName: 'User One',
            authInfo: userAuth
        });
        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            participantId: 'participant_admin',
            authInfo: adminAuth,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'quiz_1',
                    type: 'quiz',
                    properties: { prompt: 'Q', participantData: {}, resultsVisibility: 'moderators' }
                }
            }
        });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            participantId: 'participant_user_1',
            authInfo: userAuth,
            change: {
                changeType: 'submit',
                targetType: 'widget',
                targetRef: 'quiz_1',
                participantId: 'participant_admin',
                data: { answer: 'spoof attempt' }
            }
        });

        const moderatorView = await getRoomBlackboard(context, { roomId: meeting.roomId, authInfo: adminAuth });
        const quiz = moderatorView.blackboard.widgets.find((widget) => widget.id === 'quiz_1');
        assert.equal(quiz.properties.participantData.participant_admin, undefined);
        assert.deepEqual(quiz.properties.participantData.participant_user_1, { answer: 'spoof attempt' });
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('webmeet blackboard strips non-admin visibility authority from final changes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-blackboard-visibility-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.ploinky', 'webmeet');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });

    try {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const userAuth = { user: { id: 'local:user-1', username: 'user1', roles: ['user'] } };
        const context = await createStoreContext(root);
        const meeting = await createMeeting(context, { name: 'Blackboard visibility test', authInfo: adminAuth });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            participantId: 'participant_user_1',
            displayName: 'User One',
            authInfo: userAuth
        });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            participantId: 'participant_user_1',
            authInfo: userAuth,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'shape_private',
                    type: 'shape',
                    visibility: { mode: 'moderators' },
                    properties: { geometry: { x: 0, y: 0, width: 20, height: 20 } }
                }
            }
        });

        const adminView = await getRoomBlackboard(context, { roomId: meeting.roomId, authInfo: adminAuth });
        const widget = adminView.blackboard.widgets.find((entry) => entry.id === 'shape_private');
        assert.deepEqual(widget.visibility, { mode: 'all' });
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});
