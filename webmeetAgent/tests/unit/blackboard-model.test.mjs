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
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import {
    ROOM_EVENT_TYPES,
    WebMeetRoomEvents
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/room/webmeet-room-events.js';
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
import { BlackboardNetworkAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/blackboard/blackboard-network-adapter.js';
import {
    getBlackboardTheme,
    getBlackboardThemeOptions
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-theme-presets.js';

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
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel'
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

test('blackboard theme changes reset widget theme style fields', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'shape_1',
        type: 'shape',
        properties: {
            style: { fill: '#ffffff', stroke: '#334155', strokeWidth: 2 }
        }
    }), { record: false });
    blackboard.addWidget(new BlackboardWidget({
        id: 'line_1',
        type: 'line',
        properties: {
            style: { stroke: '#334155', strokeWidth: 3 }
        }
    }), { record: false });
    blackboard.addWidget(new BlackboardWidget({
        id: 'text_1',
        type: 'text',
        properties: {
            style: {
                fill: '#ffffff',
                stroke: '#cbd5e1',
                textColor: '#172033',
                fontFamily: 'Georgia',
                fontSize: 24,
                fontWeight: '700',
                fontStyle: 'italic'
            }
        }
    }), { record: false });

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'blackboard',
        reason: 'theme',
        patch: {
            metadata: { theme: { id: 'leadership' } },
            resetThemeStyles: true
        }
    });

    assert.deepEqual(blackboard.metadata.theme, { id: 'leadership' });
    assert.deepEqual(blackboard.getWidget('shape_1').properties.style, {});
    assert.deepEqual(blackboard.getWidget('line_1').properties.style, {});
    assert.deepEqual(blackboard.getWidget('text_1').properties.style, {
        fontFamily: 'Georgia',
        fontSize: 24,
        fontWeight: '700',
        fontStyle: 'italic'
    });
});

test('blackboard filters participant data for normal participants and exposes it to moderators', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'card_1',
        type: 'card',
        properties: {
            text: '2 + 2',
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
        id: 'poll_1',
        type: 'poll',
        visibility: 'user:alice',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            resultsVisibility: 'afterPoll',
            anonymous: true
        }
    }));
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' }, participantName: 'Alice Smith' }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    });

    const alice = blackboard.serialize({ participantId: 'alice', roles: [] });
    const bob = blackboard.serialize({ participantId: 'bob', roles: [] });
    const moderator = blackboard.serialize({ participantId: 'mod', roles: ['moderator'] });

    assert.equal(alice.widgets.length, 1);
    assert.deepEqual(alice.widgets[0].properties.participantData, {});
    assert.deepEqual(alice.widgets[0].properties.aggregation, {
        questions: { q1: { counts: { A: 1, B: 1 }, total: 2 } },
        totalParticipants: 2
    });
    assert.equal(bob.widgets.length, 0);
    assert.equal(moderator.widgets.length, 1);
});

test('blackboard poll submit validates options and computes aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            resultsVisibility: 'public'
        }
    }));

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' }, participantName: 'Alice Smith' }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.participantData, {
        alice: { answers: { q1: 'A' }, participantName: 'Alice Smith' },
        bob: { answers: { q1: 'B' } }
    });
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 1, B: 1 }, total: 2 } },
        totalParticipants: 2
    });
});

test('blackboard poll rejects invalid options and locked poll changes', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            allowPollChange: false
        }
    }));

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'C' } }
    }), /Invalid poll option/);

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'B' } }
    }), /Poll cannot be changed/);
});

test('blackboard poll can allow participant poll changes', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            allowPollChange: true
        }
    }));

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    });
    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'B' } }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.participantData, { alice: { answers: { q1: 'B' } } });
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 0, B: 1 }, total: 1 } },
        totalParticipants: 1
    });
});

test('blackboard poll supports rating mode aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Rate',
                questions: [{ id: 'q1', prompt: 'Rate one', pollMode: 'rating', ratingMax: 5 }]
            }
        }
    });

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: '5' } }
    });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: '6' } }
    }), /Invalid poll option/);

    const poll = blackboard.getWidget('poll_1');
    assert.deepEqual(poll.properties.questions[0].options, ['1', '2', '3', '4', '5']);
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 1 }, total: 1 } },
        totalParticipants: 1
    });
});

test('blackboard poll owner and admin can manage but participants cannot', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Pick',
                questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }]
            }
        }
    });

    const poll = blackboard.getWidget('poll_1');
    assert.equal(poll.createdBy, 'owner');
    assert.equal(poll.properties.ownerParticipantId, 'owner');

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'other',
        patch: { properties: { description: 'Nope' } }
    }), /Only the poll creator or an admin/);

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'owner',
        patch: { properties: { description: 'Updated by owner' } }
    });
    assert.equal(blackboard.getWidget('poll_1').properties.description, 'Updated by owner');

    blackboard.applyFinalChange({
        changeType: 'update',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'admin',
        patch: { properties: { description: 'Updated by admin' } }
    }, { canManagePoll: true });
    assert.equal(blackboard.getWidget('poll_1').properties.description, 'Updated by admin');
});

test('blackboard poll timer start close and expiry rules', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        participantId: 'owner',
        widget: {
            id: 'poll_1',
            type: 'poll',
            properties: {
                description: 'Timed',
                questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
                durationSeconds: 120
            }
        }
    });

    assert.equal(blackboard.getWidget('poll_1').properties.status, 'draft');
    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    }), /Poll is not open/);

    blackboard.applyFinalChange({
        changeType: 'start',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'owner'
    }, { nowIso: '2026-06-19T10:00:00.000Z' });
    assert.equal(blackboard.getWidget('poll_1').properties.status, 'open');
    assert.equal(blackboard.getWidget('poll_1').properties.closesAt, '2026-06-19T10:02:00.000Z');

    blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'alice',
        data: { answers: { q1: 'A' } }
    }, { nowMs: Date.parse('2026-06-19T10:01:00.000Z') });

    assert.throws(() => blackboard.applyFinalChange({
        changeType: 'submit',
        targetType: 'widget',
        targetRef: 'poll_1',
        participantId: 'bob',
        data: { answers: { q1: 'B' } }
    }, { nowMs: Date.parse('2026-06-19T10:03:00.000Z') }), /Poll is closed/);
    assert.equal(blackboard.getWidget('poll_1').properties.status, 'closed');
});

test('blackboard poll updates cannot overwrite participant data or aggregation', () => {
    const blackboard = new Blackboard({ roomId: 'room_1' });
    blackboard.addWidget(new BlackboardWidget({
        id: 'poll_1',
        type: 'poll',
        properties: {
            description: 'Pick',
            questions: [{ id: 'q1', prompt: 'Pick one', pollMode: 'choice', options: ['A', 'B'] }],
            participantData: { alice: { answers: { q1: 'A' } } },
            aggregation: {
                questions: { q1: { counts: { A: 99, B: 0 }, total: 99 } },
                totalParticipants: 99
            }
        }
    }));

    blackboard.patchWidget('poll_1', {
        properties: {
            participantData: { mallory: { answers: { q1: 'B' } } },
            aggregation: {
                questions: { q1: { counts: { A: 0, B: 99 }, total: 99 } },
                totalParticipants: 99
            },
            description: 'Changed'
        }
    }, { canManagePoll: true });

    const poll = blackboard.getWidget('poll_1');
    assert.equal(poll.properties.description, 'Changed');
    assert.deepEqual(poll.properties.participantData, {});
    assert.deepEqual(poll.properties.aggregation, {
        questions: { q1: { counts: { A: 0, B: 0 }, total: 0 } },
        totalParticipants: 0
    });
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

test('blackboard realtime events are routed to dashboard room handlers', () => {
    const codec = new WebMeetRoomEvents();

    assert.equal(
        codec.resolveRoomEventType(WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED),
        ROOM_EVENT_TYPES.BLACKBOARD_UPDATED
    );
    assert.equal(
        codec.resolveRoomEventType(WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED),
        ROOM_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED
    );
});

test('blackboard protocol serializes final filtered objects with actor addresses', () => {
    const encoded = encodeBlackboardProtocolMessage({
        from: 'user:participant_1',
        to: 'ALL',
        payload: {
            kind: 'widget',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
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
    assert.equal(parsed.payload.boardId, 'agent:agent_robo_team');
    assert.equal(parsed.payload.object.id, 'widget_1');
});

test('blackboard network adapter deduplicates and applies final protocol objects without resync', async () => {
    let resyncCount = 0;
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
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
            boardId: 'agent:agent_robo_team',
            messageId: 'bb_msg_1',
            version: 4,
            visibility: { mode: 'all' },
            object: { id: 'widget_1', type: 'text', version: 4, properties: { text: 'Done' } }
        }
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        boardId: 'agent:agent_robo_team',
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

test('blackboard theme updates are broadcast as full blackboard updates for other participants', async () => {
    const received = [];
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room_1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant_2',
        runTool: async () => {
            throw new Error('Theme broadcast should not require resync.');
        }
    });
    adapter.subscribe((payload) => received.push(payload));

    const blackboardMessage = encodeBlackboardProtocolMessage({
        from: 'user:participant_1',
        to: 'ALL',
        payload: {
            kind: 'blackboard',
            roomId: 'room_1',
            boardId: 'agent:agent_robo_team',
            messageId: 'bb_theme_1',
            version: 8,
            visibility: { mode: 'all' },
            object: {
                roomId: 'room_1',
                boardId: 'agent:agent_robo_team',
                version: 8,
                metadata: { theme: { id: 'leadership' } },
                widgets: []
            }
        }
    });
    const encodedEvent = buildWebMeetEvent('room_1', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
        meetingId: 'room_1',
        boardId: 'agent:agent_robo_team',
        blackboardVersion: 8,
        changeType: 'update',
        targetType: 'blackboard',
        objectKind: 'blackboard',
        blackboardMessage
    });

    assert.equal(await adapter.handleEncodedEvent(encodedEvent), 'applied');
    assert.equal(received[0].kind, 'blackboard');
    assert.equal(received[0].object.metadata.theme.id, 'leadership');
});

test('blackboard UI editing does not use browser prompt dialogs', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
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
    assert.match(source, /addEventListener\('dblclick'/);
    assert.match(source, /createContextButton\('settings', 'Widget settings'/);
    assert.match(source, /void this\.editWidget\(widget\)/);
    assert.match(source, /showModal\('webmeet-blackboard-widget-editor'/);
    assert.match(source, /getEditableWidgetProperty/);
    assert.match(source, /\[property\]: nextText/);
    assert.match(source, /return 'text'/);
    assert.doesNotMatch(source, /widget\?\.type === 'card' \? 'label' : 'text'/);
    assert.match(source, /webmeet-blackboard-toolbar/);
    assert.match(editorSource, /closeModal\(\)/);
    assert.doesNotMatch(editorSource, /blackboard-editor-save/);
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

test('blackboard inline text editing survives render refresh and flushes before toolbar history actions', async () => {
    const source = await readBlackboardPanelSource();
    const renderWidgetsMethod = source.slice(
        source.indexOf('    renderWidgets()'),
        source.indexOf('\n    renderWidget(widget)', source.indexOf('    renderWidgets()'))
    );
    const startInlineTextEditMethod = source.slice(
        source.indexOf('    startInlineTextEdit(widget)'),
        source.indexOf('\n    flushInlineTextEdit()', source.indexOf('    startInlineTextEdit(widget)'))
    );
    const flushInlineTextEditMethod = source.slice(
        source.indexOf('    async flushInlineTextEdit()'),
        source.indexOf('\n    async finishInlineTextEdit', source.indexOf('    async flushInlineTextEdit()'))
    );

    assert.match(renderWidgetsMethod, /if \(this\.inlineEditWidgetId\)/);
    assert.match(renderWidgetsMethod, /this\.pendingRenderAfterInlineEdit = true/);
    assert.match(startInlineTextEditMethod, /this\.inlineEditState = \{/);
    assert.match(startInlineTextEditMethod, /void this\.finishInlineTextEdit\(true\)/);
    assert.match(flushInlineTextEditMethod, /await this\.finishInlineTextEdit\(true\)/);
    assert.match(flushInlineTextEditMethod, /await this\.inlineEditCommitPromise/);
    assert.doesNotMatch(source, /async setTextWidgetStyle\(detail = \{\}\)/);
    assert.match(source, /async undo\(\) \{[\s\S]*await this\.flushInlineTextEdit\(\)/);
    assert.match(source, /async redo\(\) \{[\s\S]*await this\.flushInlineTextEdit\(\)/);
});

test('blackboard realtime widget updates refresh the rendered panel', async () => {
    const panelSource = await readBlackboardPanelSource();
    const controllerSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );

    assert.match(panelSource, /this\.handleUpdateEvent = \(event\) => this\.applyBlackboardUpdate\(event\.detail \|\| \{\}\)/);
    assert.match(panelSource, /applyBlackboardUpdate\(detail = \{\}\)[\s\S]*detail\?\.widget[\s\S]*this\.applyWidgetObject\(detail\.widget\)/);
    assert.match(panelSource, /adapter && adapter !== this\.adapter[\s\S]*this\.unsubscribeAdapter\?\.\(\)/);
    assert.match(controllerSource, /payload\.kind === 'widget'[\s\S]*webmeet-blackboard-update[\s\S]*widget: payload\.object/);
});

test('blackboard panel addWidget uses connected adapter', async () => {
    const { WebMeetBlackboardPanel } = await import(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.js')
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
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const participantSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css'),
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

test('blackboard widgets support final resize changes for shape line card text and image', async () => {
    const source = await readBlackboardPanelSource();
    const css = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.match(source, /canResizeWidget\(widget\)[\s\S]*\['shape', 'line', 'card', 'text', 'image'\]\.includes/);
    assert.match(source, /renderResizeHandles\(node, widget\)/);
    assert.match(source, /data-resize-handle/);
    assert.match(source, /reason: 'resize'/);
    assert.match(source, /\.\.\.geometry/);
    assert.match(source, /event\.target\?\.closest\?\.\('\[data-resize-handle\]'\)/);
    assert.match(css, /\.webmeet-blackboard-resize-handle/);
    assert.match(css, /\.webmeet-blackboard-widget\[aria-selected="true"\] \.webmeet-blackboard-resize-handle/);
});

test('blackboard poll widget renders summary modal and poll settings', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );
    const editorHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.html'),
        'utf8'
    );
    const editorSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-widget-editor/webmeet-blackboard-widget-editor.js'),
        'utf8'
    );
    const pollModalHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.html'),
        'utf8'
    );
    const pollModalSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.js'),
        'utf8'
    );
    const pollModalCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-modal/webmeet-blackboard-poll-modal.css'),
        'utf8'
    );
    const pollResultsModalHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.html'),
        'utf8'
    );
    const pollResultsModalSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.js'),
        'utf8'
    );
    const pollResultsModalCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-poll-results-modal/webmeet-blackboard-poll-results-modal.css'),
        'utf8'
    );
    const pluginConfig = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/config.json'),
        'utf8'
    );

    assert.match(panelSource, /renderPollWidgetContent\(node, widget\)/);
    assert.match(panelSource, /void this\.openPollModal\(widget\)/);
    assert.match(panelSource, /void this\.openPollResultsModal\(widget\)/);
    assert.match(panelSource, /webmeet-blackboard-poll-summary subtle-button/);
    assert.match(panelSource, /createPollAdminActions\(widget, statusValue, canManagePoll\)/);
    assert.match(panelSource, /void this\.startPollWidget\(widget\)/);
    assert.match(panelSource, /void this\.closePollWidget\(widget\)/);
    assert.match(panelSource, /resultsButton\.textContent = 'Results'/);
    assert.doesNotMatch(panelSource, /createResultsElement\(\)/);
    assert.doesNotMatch(panelSource, /createParticipantTable\(\)/);
    assert.match(panelCss, /\.webmeet-blackboard-poll-summary/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-results/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-table/);
    assert.doesNotMatch(panelCss, /\.webmeet-blackboard-poll-button/);
    assert.match(pluginConfig, /"component": "webmeet-blackboard-poll-modal"/);
    assert.match(pluginConfig, /"component": "webmeet-blackboard-poll-results-modal"/);
    assert.match(pollModalHtml, /class="modal-header"/);
    assert.match(pollModalHtml, /class="general-button"/);
    assert.match(pollModalHtml, /class="webmeet-blackboard-poll-modal-layout" data-role="questions"/);
    assert.doesNotMatch(pollModalHtml, /data-role="participantsSection"/);
    assert.doesNotMatch(pollModalHtml, /data-role="resultsSection"/);
    assert.match(pollModalSource, /input\.type = 'radio'/);
    assert.match(pollModalSource, /participantName: this\.participantName \|\| this\.participantId/);
    assert.match(pollModalSource, /renderQuestion\(question\)/);
    assert.match(pollModalSource, /options\.className = 'webmeet-blackboard-poll-modal-options'/);
    assert.doesNotMatch(pollModalSource, /if \(total > 0 && count === 0\) continue/);
    assert.doesNotMatch(pollModalSource, /createParticipantTable\(\)/);
    assert.doesNotMatch(pollModalSource, /renderParticipants\(\)/);
    assert.doesNotMatch(panelSource, /Object\.values\(participantData\)/);
    assert.match(pollModalCss, /max-height: min\(72vh, 760px\)/);
    assert.match(pollModalCss, /overflow: auto/);
    assert.match(pollModalCss, /\.webmeet-blackboard-poll-modal-options/);
    assert.doesNotMatch(pollModalCss, /\.webmeet-blackboard-poll-participants-section/);
    assert.match(pollModalCss, /@media \(max-width: 720px\)/);
    assert.match(pollResultsModalHtml, /class="webmeet-blackboard-poll-results-modal"/);
    assert.match(pollResultsModalHtml, /data-role="participantsSection"/);
    assert.match(pollResultsModalSource, /questionRow\.className = 'webmeet-blackboard-poll-question-row'/);
    assert.match(pollResultsModalSource, /if \(total > 0 && count === 0\) continue/);
    assert.match(pollResultsModalSource, /createParticipantTable\(\)/);
    assert.match(pollResultsModalSource, /renderParticipants\(\)/);
    assert.match(pollResultsModalSource, /getParticipantDisplayName\(participantId, entry\)/);
    assert.match(pollResultsModalSource, /Object\.values\(entry\.answers \|\| \{\}\)\.join/);
    assert.match(pollResultsModalCss, /grid-template-columns: minmax\(160px, 0\.52fr\) minmax\(260px, 1fr\)/);
    assert.match(pollResultsModalCss, /\.webmeet-blackboard-poll-participants-section/);
    assert.match(editorHtml, /data-role="questions"/);
    assert.match(editorHtml, /data-role="addQuestion"/);
    assert.match(editorHtml, /data-role="allowPollChange"/);
    assert.match(editorHtml, /data-role="anonymous"/);
    assert.match(editorHtml, /data-role="durationSeconds"/);
    assert.match(editorSource, /patch\.properties\.description = text/);
    assert.match(editorSource, /addPollQuestion\(\)/);
    assert.match(editorSource, /renderPollQuestionInputs\(questions/);
    assert.match(editorSource, /data-role="questionPollMode"/);
    assert.match(editorSource, /data-role="questionOptions"/);
    assert.match(editorSource, /data-role="questionRatingMax"/);
    assert.match(editorSource, /patch\.properties\.questions = questions\.map/);
    assert.match(editorSource, /patch\.properties\.allowPollChange = this\.allowPollChangeInput\?\.checked === true/);
    assert.match(editorSource, /patch\.properties\.anonymous = this\.anonymousInput\?\.checked === true/);
    assert.match(editorSource, /patch\.properties\.durationSeconds/);
});

test('blackboard supports image upload widgets', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
    );
    const panelSource = await readBlackboardPanelSource();
    const toolbarHtml = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.html'),
        'utf8'
    );
    const toolbarSource = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-toolbar/webmeet-blackboard-toolbar.js'),
        'utf8'
    );
    const panelCss = await fs.readFile(
        path.join(componentDir, 'webmeet-blackboard-panel/webmeet-blackboard-panel.css'),
        'utf8'
    );

    assert.match(toolbarHtml, /data-local-action="uploadImageWidget"/);
    assert.match(toolbarHtml, /accept="image\/\*"/);
    assert.match(toolbarSource, /blackboard-image-upload/);
    assert.match(panelSource, /addImageWidgetFromFile\(file\)/);
    assert.match(panelSource, /createWidget\('image'\)/);
    assert.match(panelSource, /widget\.type === 'image'/);
    assert.match(panelSource, /className = 'webmeet-blackboard-image-frame'/);
    assert.match(panelSource, /className = 'webmeet-blackboard-image'/);
    assert.match(panelSource, /\['shape', 'line', 'card', 'text', 'image'\]\.includes/);
    assert.match(panelCss, /\.webmeet-blackboard-image-frame/);
    assert.match(panelCss, /\.webmeet-blackboard-image-frame[\s\S]*border: var\(--stroke-width/);
});

test('blackboard supports shape variants angled lines and arrows', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
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
    assert.match(panelSource, /canRotateWidget\(widget\)[\s\S]*\['shape', 'line', 'text', 'image'\]\.includes/);
    assert.match(panelCss, /\.webmeet-blackboard-line-svg/);
    assert.match(panelCss, /\.webmeet-blackboard-resize-handle\.line-endpoint/);
    assert.doesNotMatch(editorHtml, /data-role="shapeKind"/);
    assert.match(editorHtml, /data-role="lineMarker"/);
    assert.match(editorHtml, /data-role="strokeWidth"/);
    assert.match(editorHtml, /data-role="textColor"/);
    assert.match(editorHtml, /data-role="textSection"/);
    assert.match(editorHtml, /data-role="typographySection"/);
    assert.match(editorHtml, /data-role="fontFamily"/);
    assert.match(editorHtml, /data-role="fontSize"/);
    assert.match(editorHtml, /data-role="textStyleColor"/);
    assert.match(editorHtml, /data-role="fontBold"/);
    assert.match(editorHtml, /data-role="fontItalic"/);
    assert.match(editorHtml, /data-role="choiceSection"/);
    assert.match(editorHtml, /data-role="surfaceSection"/);
    assert.doesNotMatch(toolbarHtml, /webmeet-blackboard-text-toolbar/);
    assert.doesNotMatch(toolbarHtml, /data-text-style/);
    assert.doesNotMatch(editorHtml, /data-role="lineAngle"/);
    assert.doesNotMatch(editorSource, /patch\.properties\.shapeKind/);
    assert.match(editorSource, /SURFACE_WIDGET_TYPES/);
    assert.match(editorSource, /TEXT_COLOR_WIDGET_TYPES/);
    assert.match(panelSource, /'theme-json': encodeURIComponent\(JSON\.stringify\(this\.getBlackboardTheme\(\)\)\)/);
    assert.match(editorSource, /readJsonAttribute\(element, 'data-theme-json'\)/);
    assert.match(editorSource, /delete style\[property\]/);
    assert.match(editorSource, /sameColor\(normalizedValue, normalizedDefault\)/);
    assert.match(editorSource, /style\.fontFamily/);
    assert.match(editorSource, /style\.fontSize/);
    assert.match(editorSource, /style\.fontWeight/);
    assert.match(editorSource, /style\.fontStyle/);
    assert.match(editorHtml, /data-role="fillTransparent"/);
    assert.match(editorSource, /style\.fill = 'transparent'/);
    assert.match(editorSource, /this\.setThemedStyleValue\(style, 'fill', this\.fillInput\?\.value, typeDefaults\.fill\)/);
    assert.match(editorSource, /patch\.properties\.line/);
    assert.match(editorSource, /strokeWidth/);
    assert.match(panelCss, /border: var\(--stroke-width/);
    assert.match(panelCss, /background: var\(--fill/);
    assert.doesNotMatch(editorSource, /lineAngleInput/);
});

test('blackboard toolbar uses themes instead of manual board background controls', async () => {
    const componentDir = path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard'
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

    assert.doesNotMatch(toolbarHtml, /data-background-color/);
    assert.doesNotMatch(toolbarSource, /blackboard-background/);
    assert.doesNotMatch(toolbarHtml, /data-local-action="setTool select"/);
    assert.doesNotMatch(toolbarHtml, /data-local-action="runToolbarAction delete"/);
    assert.doesNotMatch(toolbarHtml, /data-action=/);
    assert.doesNotMatch(toolbarSource, /setTool\(_target, tool = 'select'\)/);
    assert.match(toolbarSource, /addWidget\(_target, type = 'shape'\)/);
    assert.match(toolbarSource, /runToolbarAction\(_target, action = ''\)/);
    assert.match(toolbarSource, /constructor\(element, invalidate\)/);
    assert.doesNotMatch(toolbarSource, /registerAction/);
    assert.doesNotMatch(toolbarSource, /addEventListener\('click'/);
    assert.doesNotMatch(toolbarSource, /handleToolbarClick/);
    assert.doesNotMatch(panelSource, /setBlackboardBackground\(background = \{\}\)/);
    assert.match(panelSource, /targetType: 'blackboard'/);
    assert.doesNotMatch(panelSource, /metadata: \{[\s\S]*background:/);
    assert.match(panelSource, /applyBoardBackground\(\)/);
    assert.doesNotMatch(panelCss, /--blackboard-background-color/);
});

test('blackboard exposes Leadership theme extracted from the provided palette', () => {
    const options = getBlackboardThemeOptions();
    const theme = getBlackboardTheme('leadership');

    assert.ok(options.some((option) => option.id === 'leadership' && option.label === 'Leadership'));
    assert.equal(theme.tokens.boardBackground, '#f4f2f1');
    assert.equal(theme.tokens.panelBackground, '#e2dedd');
    assert.equal(theme.tokens.boardGridColor, '#d8d6d5');
    assert.equal(theme.tokens.widgetBorder, '#5d9cac');
    assert.equal(theme.tokens.selectionColor, '#6276b7');
    assert.equal(theme.defaults.shape.fill, '#d7eef0');
    assert.equal(theme.defaults.shape.stroke, '#5d9cac');
    assert.equal(theme.defaults.line.stroke, '#6276b7');
    assert.equal(theme.defaults.text.fill, 'transparent');
    assert.equal(theme.defaults.text.stroke, '#91c9c8');
    assert.equal(theme.defaults.text.textColor, '#315f86');
});

test('blackboard text widget theme defaults are transparent in every theme', () => {
    for (const option of getBlackboardThemeOptions()) {
        const theme = getBlackboardTheme(option.id);
        assert.equal(theme.defaults.text.fill, 'transparent', `${option.id} text fill`);
    }
    assert.equal(getBlackboardTheme('slate').defaults.text.textColor, '#e0f2fe');
    assert.equal(getBlackboardTheme('contrast').tokens.widgetText, '#ffffff');
    assert.equal(getBlackboardTheme('contrast').defaults.text.textColor, '#ffffff');
});

test('blackboard image widget defaults are transparent and borderless in every theme', () => {
    for (const option of getBlackboardThemeOptions()) {
        const theme = getBlackboardTheme(option.id);
        assert.equal(theme.defaults.image.fill, 'transparent', `${option.id} image fill`);
        assert.equal(theme.defaults.image.strokeWidth, 0, `${option.id} image strokeWidth`);
        assert.match(theme.defaults.image.stroke, /^#[0-9a-f]{6}$/i, `${option.id} image stroke`);
    }
});

test('blackboard widgets rely on theme defaults until a style is explicitly set', async () => {
    const source = await readBlackboardPanelSource();

    assert.match(source, /properties: \{\s*geometry: baseGeometry,\s*style: \{\}\s*\}/);
    assert.doesNotMatch(source, /fill: shapeDefaults\.fill/);
    assert.doesNotMatch(source, /stroke: shapeDefaults\.stroke/);
    assert.doesNotMatch(source, /stroke: lineDefaults\.stroke/);
    assert.doesNotMatch(source, /textColor: textDefaults\.textColor/);
    assert.match(source, /normalizedType === 'text'[\s\S]*fill: 'transparent'/);
    assert.match(source, /style\.fill \|\| typeDefaults\.fill/);
    assert.match(source, /style\.stroke \|\| typeDefaults\.stroke/);
    assert.match(source, /node\.style\.setProperty\('--stroke-width', `\$\{cssStrokeWidth\}px`\)/);
    assert.match(source, /normalized\.textColor \|\| textDefaults\.textColor/);
    assert.match(source, /node\.style\.setProperty\('--text-color', style\.textColor \|\| textDefaults\.textColor/);
    assert.match(source, /resetThemeStyles: true/);
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
    const widgetEditor = (config.dependencies || []).find((entry) => entry.component === 'webmeet-blackboard-widget-editor');
    assert.equal(widgetEditor?.type, 'modal');
});

test('blackboard panel is a static WebSkel child driven through DOM events', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js'),
        'utf8'
    );
    const panelSource = await readBlackboardPanelSource();
    const parentSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );
    const dashboardHtml = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.resolve(import.meta.dirname, '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.js'),
        'utf8'
    );

    assert.match(dashboardHtml, /<webmeet-blackboard-panel data-presenter="webmeet-blackboard-panel"><\/webmeet-blackboard-panel>/);
    assert.doesNotMatch(source, /webSkel\.createElement/);
    assert.doesNotMatch(source, /waitForBlackboardPanelReady/);
    assert.doesNotMatch(source, /ensureBlackboardPanel/);
    assert.doesNotMatch(source, /ensureBlackboardComponentsRegistered/);
    assert.doesNotMatch(source, /requestAnimationFrame/);
    assert.doesNotMatch(source, /\.configure\(/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-toolbar'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-widget-editor'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-results-panel'\)/);
    assert.doesNotMatch(parentSource, /ensureComponentRegistered\('webmeet-blackboard-panel'\)/);
    assert.match(dashboardSource, /void ensureAvatarSettingsFormRegistered\(\)/);
    assert.match(dashboardSource, /async beforeRender\(\)[\s\S]*prepareInitialRouteState/);
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
                `../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/${componentName}/${componentName}.js`
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
            boardId: 'agent:agent_robo_team',
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

        const response = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            authInfo
        });
        const events = await listMeetingEvents(context, meeting.roomId);
        const record = await loadRoomRecord(context, meeting.roomId);
        const payload = decryptRoomPayload(context, record);
        const roboTeam = payload.agents.find((agent) => agent.id === 'agent_robo_team');

        assert.ok(response.blackboard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.equal(response.blackboard.boardId, 'agent:agent_robo_team');
        assert.equal(response.blackboard.boardOwnerType, 'agent');
        assert.equal(response.blackboard.boardOwnerId, 'agent_robo_team');
        assert.equal(response.blackboard.boardVisibility, 'room');
        assert.equal(payload.blackboard, undefined);
        assert.ok(roboTeam.blackboard.widgets.some((widget) => widget.id === 'shape_1'));
        assert.equal(roboTeam.blackboard.boardId, 'agent:agent_robo_team');
        assert.equal(roboTeam.blackboard.metadata.boardOwnerType, 'agent');
        assert.ok(events.some((event) => parseWebMeetEvent(event).type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED));
        assert.ok(events.some((event) => parseWebMeetEvent(event).payload.boardId === 'agent:agent_robo_team'));
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
            boardId: 'agent:agent_robo_team',
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
            boardId: 'agent:agent_robo_team',
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
        assert.equal(response.broadcast.boardId, 'agent:agent_robo_team');
        assert.equal(response.broadcast.boardOwnerType, 'agent');
        assert.equal(response.broadcast.boardOwnerId, 'agent_robo_team');
        assert.equal(response.broadcast.boardVisibility, 'room');
        assert.notEqual(response.broadcast.version, response.object.version);

        await assert.rejects(dispatch('webmeet_blackboard_get', {
            roomId: meeting.roomId,
            boardId: 'participant:participant-admin',
            participantId: 'participant-admin'
        }, context, authInfo), /Participant-owned blackboards are not enabled yet/);

        const backgroundResponse = await dispatch('webmeet_blackboard_apply', {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
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
            boardId: 'agent:agent_robo_team',
            participantId: 'participant_admin',
            authInfo: adminAuth,
            change: {
                changeType: 'create',
                targetType: 'widget',
                widget: {
                    id: 'card_1',
                    type: 'card',
                    properties: { text: 'Q', participantData: {}, resultsVisibility: 'moderators' }
                }
            }
        });

        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'participant_user_1',
            authInfo: userAuth,
            change: {
                changeType: 'submit',
                targetType: 'widget',
                targetRef: 'card_1',
                participantId: 'participant_admin',
                data: { answer: 'spoof attempt' }
            }
        });

        const moderatorView = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            authInfo: adminAuth
        });
        const card = moderatorView.blackboard.widgets.find((widget) => widget.id === 'card_1');
        assert.equal(card.properties.participantData.participant_admin, undefined);
        assert.deepEqual(card.properties.participantData.participant_user_1, { answer: 'spoof attempt' });
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
            boardId: 'agent:agent_robo_team',
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

        const adminView = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            authInfo: adminAuth
        });
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
