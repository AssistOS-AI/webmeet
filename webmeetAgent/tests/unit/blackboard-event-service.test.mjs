import test from 'node:test';
import assert from 'node:assert/strict';

import { executeBlackboardEvent } from '../../lib/blackboard/event-service.mjs';
import {
    BLACKBOARD_CREATABLE_WIDGET_TYPES,
    BLACKBOARD_WIDGET_EVENT_SCHEMAS,
    assertCanonicalWidgetPatch,
    normalizeBlackboardEvent,
    normalizeBlackboardEventResult,
    parseEventInput,
} from '../../lib/blackboard/event-contract.mjs';
import { BlackboardCommandInterpreter } from '../../lib/blackboard/blackboard-command-interpreter.mjs';
import { buildSemanticBoardContext, calculateContentBounds, calculateLineFromCenter } from '../../lib/blackboard/semantic-context.mjs';
import { Blackboard, BlackboardWidget } from '../../lib/blackboard/model.mjs';
import { action as interpretBlackboardSkill } from '../../skills/blackboard-event/src/index.mjs';

function makeDeps(overrides = {}) {
    let audit = null;
    return {
        authorizeRoomParticipant: async () => ({ participantId: 'participant-1' }),
        appendMeetingChat: async (_context, input) => {
            audit = { id: 'audit-1', message: input.message, kind: input.kind, metadata: input.metadata };
            return { message: audit, deduplicated: false };
        },
        updateMeetingChat: async (_context, input) => {
            audit = { ...audit, message: input.message, metadata: input.metadata };
            return { message: audit };
        },
        getRoomBlackboard: async () => ({
            blackboard: { boardId: 'agent:agent_robo_team', revision: 2, widgets: [], interactionContext: { focusedWidgetId: '', lastAffectedWidgetIds: [] } },
        }),
        applyRoomBlackboardEvents: async (_context, input) => ({
            ok: true,
            events: input.events,
            blackboard: { boardId: input.boardId, revision: 3, widgets: [], interactionContext: { focusedWidgetId: '', lastAffectedWidgetIds: [] } },
        }),
        ...overrides,
    };
}

test('canonical create is accepted while add, lock, unlock, transport ids, and provenance are rejected', () => {
    const event = normalizeBlackboardEvent({
        ref: 'vision',
        action: 'create',
        target: { type: 'blackboard' },
        payload: { widget: { type: 'shape', properties: { label: 'Vision' } } },
    });
    assert.equal(event.action, 'create');
    for (const action of ['add', 'lock', 'unlock', 'focus']) {
        assert.throws(() => normalizeBlackboardEvent({ action, target: { type: 'blackboard' }, payload: {} }), /Unsupported/);
    }
    assert.throws(() => normalizeBlackboardEvent({ ...event, eventId: 'forged' }), /server-controlled/);
    assert.throws(() => normalizeBlackboardEvent({ ...event, payload: { widget: { type: 'shape', properties: {}, provenance: {} } } }), /server-controlled/);
    assert.throws(() => normalizeBlackboardEvent({ action: 'update', target: { type: 'widget', widgetId: 'shape-1' }, payload: { patch: { locked: true } } }), /cannot modify locked/);
    assert.throws(() => normalizeBlackboardEvent({ action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'scripta-document', properties: {} } } }), /specialized action/);
    assert.throws(() => normalizeBlackboardEvent({ action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'ellipse', properties: {} } } }), /specialized action/);
    const circle = normalizeBlackboardEvent({
        action: 'create', target: { type: 'blackboard' },
        payload: { widget: { type: 'shape', properties: { shapeKind: 'ellipse', geometry: { x: 10, y: 20, width: 100, height: 100 } } } },
    });
    assert.equal(circle.payload.widget.properties.shapeKind, 'ellipse');
    assert.deepEqual(new Set(Object.keys(BLACKBOARD_WIDGET_EVENT_SCHEMAS)), BLACKBOARD_CREATABLE_WIDGET_TYPES);
});

test('deterministic /event form is parsed locally', () => {
    assert.deepEqual(parseEventInput('clear {"reason":"toolbar"}'), { action: 'clear', payload: { reason: 'toolbar' } });
    assert.equal(parseEventInput('mută forma la dreapta'), null);
});

test('interpreter results support ordered event lists or one natural-language error', () => {
    const result = normalizeBlackboardEventResult({ events: [{
        action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'text', properties: { text: 'A' } } },
    }] });
    assert.equal(result.events.length, 1);
    const failure = normalizeBlackboardEventResult({ error: { code: 'ambiguous_target', message: 'There are multiple Draft widgets.' } });
    assert.equal(failure.error.code, 'ambiguous_target');
    assert.throws(() => normalizeBlackboardEventResult({ error: { code: 'invented_error', message: 'No.' } }), /Unsupported interpreter error code/);
    assert.throws(() => normalizeBlackboardEventResult({ clarificationRequired: true, question: 'Which Draft?' }), /not supported/);
    assert.throws(() => normalizeBlackboardEventResult({ error: { code: 'ambiguous_target', message: 'Ambiguous.' }, events: [] }), /both an error/);
});

test('widget capability allowlists protect structural and specialized content', () => {
    assert.equal(assertCanonicalWidgetPatch({ type: 'shape' }, { properties: { geometry: { x: 10 }, label: 'Vision' } }), true);
    assert.equal(assertCanonicalWidgetPatch({ type: 'line' }, { properties: { geometryDelta: { x: 0, y: 100 } } }), true);
    assert.throws(() => assertCanonicalWidgetPatch({ type: 'line' }, { properties: { geometryDelta: { dx: 0, dy: 100 } } }), /unsupported fields: dx, dy/);
    assert.throws(() => assertCanonicalWidgetPatch({ type: 'line' }, { properties: { geometryDelta: { x: 0, y: 0 } } }), /must move at least one axis/);
    assert.throws(() => assertCanonicalWidgetPatch({ type: 'shape' }, { groupId: 'forged', properties: {} }), /cannot modify groupId/);
    assert.throws(() => assertCanonicalWidgetPatch({ type: 'scripta-document' }, { properties: { resourceId: 'forged' } }), /cannot update properties: resourceId/);
    assert.throws(() => assertCanonicalWidgetPatch({ type: 'poll' }, { properties: { participantData: {} } }), /cannot update properties: participantData/);
});

test('natural commands execute an atomic event list and expose only revision ordering', async () => {
    let executed = null;
    let interpretationContext = null;
    const deps = makeDeps({
        interpretBlackboardCommand: async (_text, context) => {
            interpretationContext = context;
            return ({ events: [
            { ref: 'vision', action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'shape', properties: { label: 'Vision' } } } },
            { action: 'update', target: { type: 'widget', ref: 'vision' }, payload: { patch: { properties: { geometryDelta: { x: 0, y: -50 } } } } },
            ] });
        },
        applyRoomBlackboardEvents: async (_context, input) => {
            executed = input;
            return { ok: true, blackboard: { boardId: input.boardId, revision: 3, widgets: [], interactionContext: {} } };
        },
    });
    const result = await executeBlackboardEvent({}, { roomId: 'room-1', event: 'creează Vision și mută-l sus', source: 'event' }, deps);
    assert.equal(result.ok, true);
    assert.equal(executed.events.length, 2);
    assert.equal('revision' in interpretationContext.board, false);
    assert.equal('expectedBoardVersion' in executed, false);
    assert.equal(executed.source, 'robo');
    assert.equal(result.auditMessage.metadata.result.boardRevision, 3);
});

test('semantic ambiguity returns an explicit error and never executes events', async () => {
    let executed = false;
    const deps = makeDeps({
        interpretBlackboardCommand: async () => ({
            error: { code: 'ambiguous_target', message: 'Pe tablă sunt mai multe elipse și nu ai specificat elipsa.' },
        }),
        applyRoomBlackboardEvents: async () => { executed = true; },
    });
    const result = await executeBlackboardEvent({}, { roomId: 'room-1', event: 'șterge elipsa', source: 'robo' }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ambiguous_target');
    assert.match(result.error.message, /mai multe elipse/);
    assert.equal(result.auditMessage.metadata.status, 'error');
    assert.equal(executed, false);
    await assert.rejects(
        executeBlackboardEvent({}, { roomId: 'room-1', source: 'ui', clarificationResponse: { clarificationId: 'old' } }, deps),
        /not supported/,
    );
});

test('interpreter timeout always shuts down the per-round MainAgent', async () => {
    let shutdown = false;
    class HangingAgent {
        executeSkill() { return new Promise(() => {}); }
        shutdown() { shutdown = true; }
    }
    await assert.rejects(
        new BlackboardCommandInterpreter({ MainAgent: HangingAgent, timeoutMs: 5 }).interpret({ text: 'wait', board: {} }),
        (error) => error.code === 'command_interpretation_timeout',
    );
    assert.equal(shutdown, true);
});

test('geometry uses logical board bounds and deterministic free-line math', () => {
    assert.deepEqual(calculateContentBounds([]), { x: 0, y: 0, width: 1200, height: 800, centerX: 600, centerY: 400 });
    const line = calculateLineFromCenter({ centerX: 600, centerY: 400, length: 200, angle: 45 });
    assert.ok(Math.abs(Math.hypot(line.x2 - line.x1, line.y2 - line.y1) - 200) < 1e-9);
    assert.ok(Math.abs((line.y2 - line.y1) - (line.x2 - line.x1)) < 1e-9);
    assert.deepEqual(calculateContentBounds([{ type: 'line', properties: { line: { x1: 20, y1: 30, x2: 220, y2: 130 } } }]), {
        x: 20, y: 30, width: 200, height: 100, centerX: 120, centerY: 80,
    });
    assert.deepEqual(calculateContentBounds([{ type: 'line', properties: { geometry: { x1: 500, y1: 400, x2: 700, y2: 400, x: 12, y: 18 } } }]), {
        x: 500, y: 400, width: 200, height: 0, centerX: 600, centerY: 400,
    });
});

test('semantic line context exposes absolute endpoints and instructs continuation from focus', async () => {
    const board = new Blackboard({
        interactionContext: { focusedWidgetId: 'line-1', lastAffectedWidgetIds: ['line-1'] },
        widgets: [{
            id: 'line-1', type: 'line',
            properties: {
                geometry: { x: 498, y: 398, width: 204, height: 4 },
                line: { x1: 2, y1: 2, x2: 202, y2: 2 },
            },
        }],
    });
    const semantic = buildSemanticBoardContext(board.serializePrivileged());
    assert.deepEqual(semantic.widgets[0].line, { x1: 500, y1: 400, x2: 700, y2: 400 });
    assert.equal(semantic.widgets[0].ordinal, 1);

    let prompt = '';
    await interpretBlackboardSkill({
        promptText: 'adaugă o linie de 100px sub unghi de 45 de grade',
        context: { board: semantic },
        llmAgent: {
            executePrompt: async (value) => {
                prompt = value;
                return { events: [{ action: 'clear', target: { type: 'blackboard' }, payload: {} }] };
            },
        },
    });
    assert.match(prompt, /properties\.line:\{x1,y1,x2,y2/);
    assert.match(prompt, /continue from that focused line/);
    assert.match(prompt, /x2\/y2 as the new x1\/y1/);
});

test('blackboard skill repairs a noncanonical circle type using the shared widget schema', async () => {
    const responses = [
        { events: [{ action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'ellipse', properties: { geometry: { x: 100, y: 100, width: 100, height: 100 } } } } }] },
        { events: [{ action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'shape', properties: { shapeKind: 'ellipse', geometry: { x: 100, y: 100, width: 100, height: 100 } } } } }] },
        { events: [{ action: 'create', target: { type: 'blackboard' }, payload: { widget: { type: 'shape', properties: { shapeKind: 'ellipse', geometry: { x: 100, y: 100, width: 100, height: 100 } } } } }] },
    ];
    const prompts = [];
    const result = await interpretBlackboardSkill({
        promptText: 'adaugă un cerc în dreapta liniei',
        context: { board: { focusedWidgetId: 'line-1', widgets: [] } },
        llmAgent: { executePrompt: async (prompt) => { prompts.push(prompt); return responses.shift(); } },
    });
    assert.equal(prompts.length, 3);
    assert.match(prompts[0], /circle -> ellipse with equal width and height/);
    assert.match(prompts[1], /Widget type \\"ellipse\\" must be created through its specialized action|Widget type "ellipse" must be created through its specialized action/);
    assert.equal(result.events[0].payload.widget.type, 'shape');
    assert.equal(result.events[0].payload.widget.properties.shapeKind, 'ellipse');
});

test('semantic verification rejects an incompatible focused target instead of mutating it', async () => {
    const circleUpdate = { events: [{
        action: 'update', target: { type: 'widget', widgetId: 'circle-1' },
        payload: { patch: { properties: { geometryDelta: { x: 0, y: 100 } } } },
    }] };
    const responses = [
        circleUpdate,
        { error: { code: 'ambiguous_target', message: 'There are multiple lines and no line ordinal was specified.' } },
    ];
    const prompts = [];
    const result = await interpretBlackboardSkill({
        promptText: 'move the line down by 100px',
        context: { board: {
            focusedWidgetId: 'circle-1',
            widgets: [
                { id: 'circle-1', type: 'shape', geometry: { x: 0, y: 0, width: 100, height: 100 } },
                { id: 'line-1', type: 'line', line: { x1: 0, y1: 0, x2: 100, y2: 0 } },
                { id: 'line-2', type: 'line', line: { x1: 0, y1: 200, x2: 100, y2: 200 } },
            ],
        } },
        llmAgent: { executePrompt: async (prompt) => { prompts.push(prompt); return responses.shift(); } },
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[1], /Explicit references outrank focus/);
    assert.equal(result.error.code, 'ambiguous_target');
    assert.match(result.error.message, /multiple lines/);
});

test('LLM semantic errors bypass executable-event verification', async () => {
    const prompts = [];
    const result = await interpretBlackboardSkill({
        promptText: 'move the line down by 100px',
        context: { board: { focusedWidgetId: 'circle-1', widgets: [
            { id: 'circle-1', type: 'shape' },
            { id: 'line-1', type: 'line' },
            { id: 'line-2', type: 'line' },
        ] } },
        llmAgent: { executePrompt: async (prompt) => {
            prompts.push(prompt);
            return { error: { code: 'ambiguous_target', message: 'There are multiple lines and none was specified.' } };
        } },
    });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /return exactly \{error:/);
    assert.deepEqual(result, {
        error: { code: 'ambiguous_target', message: 'There are multiple lines and none was specified.' },
    });
});

test('RoboTeam attribution remains separate from poll-owner authorization', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({
        id: 'poll-1', type: 'poll', createdBy: 'participant-1',
        properties: { ownerParticipantId: 'participant-1', questions: [], geometry: { x: 0, y: 0, width: 200, height: 120 } },
    }), { record: false });
    board.patchWidget('poll-1', { properties: { geometryDelta: { x: 20, y: 0 } } }, {
        participantId: 'agent_robo_team', permissionParticipantId: 'participant-1',
        provenance: { executor: 'agent_robo_team', requestedBy: 'participant-1', source: 'robo' }, record: false,
    });
    assert.equal(board.getWidget('poll-1').properties.geometry.x, 20);
    assert.equal(board.getWidget('poll-1').updatedBy, 'agent_robo_team');
});

test('moving a normalized free line changes its geometry once and preserves local endpoints', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({
        id: 'line-1', type: 'line',
        properties: { geometry: { x: 98, y: 98, width: 204, height: 4 }, line: { x1: 2, y1: 2, x2: 202, y2: 2 } },
    }), { record: false });
    board.patchWidget('line-1', { properties: { geometryDelta: { x: 0, y: -50 } } }, { record: false });
    assert.equal(board.getWidget('line-1').properties.geometry.y, 48);
    assert.deepEqual(board.getWidget('line-1').properties.line, { x1: 2, y1: 2, x2: 202, y2: 2 });
});

test('malformed AI line endpoints are migrated to the canonical line schema', () => {
    const widget = new BlackboardWidget({
        id: 'line-45', type: 'line',
        properties: { geometry: { x1: 700, y1: 400, x2: 770.710678, y2: 470.710678 } },
    });
    assert.equal(widget.properties.geometry.x, 698);
    assert.equal(widget.properties.geometry.y, 398);
    assert.equal(widget.properties.geometry.rotation, 0);
    assert.ok(Math.abs(widget.properties.geometry.width - 74.710678) < 1e-9);
    assert.ok(Math.abs(widget.properties.geometry.height - 74.710678) < 1e-9);
    assert.equal(widget.properties.line.x1, 2);
    assert.equal(widget.properties.line.y1, 2);
    assert.ok(Math.abs(widget.properties.line.x2 - 72.710678) < 1e-9);
    assert.ok(Math.abs(widget.properties.line.y2 - 72.710678) < 1e-9);
    assert.ok(Math.abs(Math.hypot(
        widget.properties.line.x2 - widget.properties.line.x1,
        widget.properties.line.y2 - widget.properties.line.y1,
    ) - 100) < 1e-6);
});

test('groups move together, resize independently, and dissolve when one member remains', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({ id: 'a', type: 'shape', properties: { geometry: { x: 0, y: 0, width: 100, height: 50 } } }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'b', type: 'shape', properties: { geometry: { x: 200, y: 0, width: 100, height: 50 } } }), { record: false });
    board.groupWidgets(['a', 'b'], { groupId: 'group-1' });
    board.patchWidget('a', { properties: { geometryDelta: { x: 40, y: 10 } } }, { record: false });
    assert.deepEqual(board.getWidget('b').properties.geometry, { x: 240, y: 10, width: 100, height: 50 });
    board.patchWidget('a', { properties: { geometry: { width: 150 } } }, { record: false });
    assert.equal(board.getWidget('b').properties.geometry.width, 100);
    board.removeWidget('a', { record: false });
    assert.equal(board.getWidget('b').groupId, '');
});

test('deleting a connection endpoint removes its dependent attached line', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({ id: 'from', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'to', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({
        id: 'edge',
        type: 'line',
        properties: { connection: { from: { widgetId: 'from', anchor: 'right' }, to: { widgetId: 'to', anchor: 'left' } } },
    }), { record: false });
    board.removeWidget('from', { record: false });
    assert.equal(board.getWidget('edge'), null);
});
