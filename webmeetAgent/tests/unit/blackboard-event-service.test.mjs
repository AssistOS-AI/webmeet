import test from 'node:test';
import assert from 'node:assert/strict';

import { executeBlackboardEvent } from '../../lib/blackboard/event-service.mjs';
import {
    BLACKBOARD_CREATABLE_WIDGET_TYPES,
    BLACKBOARD_SCRIPTA_ACTION_PAYLOAD_FIELDS,
    BLACKBOARD_WIDGET_EVENT_SCHEMAS,
    assertCanonicalWidgetPatch,
    getBlackboardScriptaEventSchemaPrompt,
    normalizeBlackboardEvent,
    normalizeBlackboardEventResult,
    parseEventInput,
} from '../../lib/blackboard/event-contract.mjs';
import { BlackboardCommandInterpreter } from '../../lib/blackboard/blackboard-command-interpreter.mjs';
import {
    getBlackboardStructuredResultSchema,
    normalizeBlackboardStructuredResult,
} from '../../lib/blackboard/structured-result-schema.mjs';
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

test('SCRIPTA event payloads are flat and chapter rename requires a real title', () => {
    assert.throws(() => normalizeBlackboardEvent({
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { mutation: { chapterOrdinal: 1, title: 'test' } },
    }), /unsupported fields: mutation/);
    assert.throws(() => normalizeBlackboardEvent({
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { chapterOrdinal: 1, title: '   ' },
    }), /requires a non-empty title/);
    const event = normalizeBlackboardEvent({
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { chapterOrdinal: 1, title: '  test   chapter  ' },
    });
    assert.deepEqual(event.payload, { chapterOrdinal: 1, title: 'test chapter' });
    const structuredActions = getBlackboardStructuredResultSchema()
        .properties.events.anyOf[0].items.properties.action.enum;
    assert.deepEqual(
        new Set(Object.keys(BLACKBOARD_SCRIPTA_ACTION_PAYLOAD_FIELDS)),
        new Set(structuredActions.filter((action) => action.startsWith('scripta-')))
    );
    const prompt = getBlackboardScriptaEventSchemaPrompt();
    assert.match(prompt, /scripta-chapter-edit: payload=\{resourceId,chapterId,chapterOrdinal,title\}/);
    assert.doesNotMatch(prompt, /scripta-chapter-edit:[^\n]*type/);
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

test('structured result schema covers every public action and both terminal result branches', () => {
    const schema = getBlackboardStructuredResultSchema();
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['events', 'error']);
    assert.equal(schema.anyOf.length, 2);
    assert.equal(schema.anyOf[0].properties.events.minItems, 1);
    assert.deepEqual(schema.anyOf[0].properties.error, { type: 'null' });
    assert.deepEqual(schema.anyOf[1].properties.events, { type: 'null' });
    assert.equal(schema.anyOf[1].properties.error.additionalProperties, false);
    const eventSchema = schema.properties.events.anyOf[0].items;
    assert.deepEqual(eventSchema.properties.action.enum, [...eventSchema.properties.action.enum]);
    assert.deepEqual(new Set(eventSchema.properties.action.enum), new Set([
        'create', 'update', 'delete', 'group', 'ungroup', 'clear', 'undo', 'redo', 'show', 'hide',
        'submit', 'start', 'close', 'reorder',
        'scripta-document-create', 'scripta-document-open', 'scripta-document-delete',
        'scripta-paragraph-open', 'scripta-document-view', 'scripta-paragraph-next', 'scripta-paragraph-previous',
        'scripta-p-variant-add', 'scripta-p-variant-select', 'scripta-p-variant-edit-start',
        'scripta-p-variant-edit-cancel', 'scripta-p-variant-edit', 'scripta-p-variant-delete',
        'scripta-p-variant-vote', 'scripta-p-variant-vote-withdraw', 'scripta-p-variant-reformulate',
        'scripta-undo', 'scripta-chapter-add', 'scripta-chapter-edit', 'scripta-chapter-delete',
        'scripta-chapter-move', 'scripta-paragraph-add', 'scripta-paragraph-delete', 'scripta-paragraph-move',
    ]));
});

test('structured result normalization removes nullable transport fields and restores poll answer maps', () => {
    assert.deepEqual(normalizeBlackboardStructuredResult({
        events: [{
            ref: null,
            action: 'submit',
            target: { type: 'widget', widgetId: 'poll-1', ref: null },
            payload: {
                widget: null,
                data: {
                    answers: [{ questionId: 'q1', answer: 'Yes' }],
                    participantName: null,
                },
            },
        }],
        error: null,
    }), {
        events: [{
            action: 'submit',
            target: { type: 'widget', widgetId: 'poll-1' },
            payload: { data: { answers: { q1: 'Yes' } } },
        }],
    });
    assert.throws(
        () => normalizeBlackboardStructuredResult({ events: null, error: null }),
        /exactly one non-empty terminal branch/,
    );
    assert.throws(
        () => normalizeBlackboardStructuredResult({ events: [], error: null }),
        /exactly one non-empty terminal branch/,
    );
    assert.throws(
        () => normalizeBlackboardStructuredResult({
            events: [{ action: 'clear' }],
            error: { code: 'unsupported_request', message: 'No.' },
        }),
        /exactly one non-empty terminal branch/,
    );
});

test('blackboard skill prefers provider-native structured output with the canonical schema', async () => {
    const calls = [];
    const result = await interpretBlackboardSkill({
        promptText: 'clear the board',
        context: { board: { widgets: [] } },
        llmAgent: {
            executeStructuredPrompt: async (_prompt, options) => {
                calls.push(options);
                return {
                    events: [{ ref: null, action: 'clear', target: { type: 'blackboard', widgetId: null, ref: null }, payload: {} }],
                    error: null,
                };
            },
        },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].schemaName, 'webmeet_blackboard_result');
    assert.equal(calls[0].strict, true);
    assert.equal(calls[0].schema.additionalProperties, false);
    assert.equal(result.events[0].action, 'clear');
});

test('blackboard skill preserves strict structured output on older Achilles prompt APIs', async () => {
    const calls = [];
    const result = await interpretBlackboardSkill({
        promptText: 'clear the board',
        context: { board: { widgets: [] } },
        llmAgent: {
            executePrompt: async (_prompt, options) => {
                calls.push(options);
                return { events: [{ action: 'clear', target: { type: 'blackboard' }, payload: {} }], error: null };
            },
        },
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].params.response_format.type, 'json_schema');
    assert.equal(calls[0].params.response_format.json_schema.strict, true);
    assert.equal(calls[0].params.response_format.json_schema.name, 'webmeet_blackboard_result');
    assert.equal(result.events[0].action, 'clear');
});

test('blackboard skill retries one rejected structured result through the same strict channel', async () => {
    let calls = 0;
    const result = await interpretBlackboardSkill({
        promptText: 'clear the board',
        context: { board: { widgets: [] } },
        llmAgent: {
            executeStructuredPrompt: async () => {
                calls += 1;
                if (calls === 1) throw new Error('The provider rejected the first structured result.');
                return { events: [{ action: 'clear', target: { type: 'blackboard' }, payload: {} }], error: null };
            },
        },
    });
    assert.equal(calls, 3);
    assert.equal(result.events[0].action, 'clear');
});

test('blackboard skill repairs an empty structured terminal envelope', async () => {
    let calls = 0;
    const result = await interpretBlackboardSkill({
        promptText: 'clear the board',
        context: { board: { widgets: [] } },
        llmAgent: {
            executeStructuredPrompt: async () => {
                calls += 1;
                if (calls === 1) return { events: null, error: null };
                return {
                    events: [{ action: 'clear', target: { type: 'blackboard' }, payload: {} }],
                    error: null,
                };
            },
        },
    });
    assert.equal(calls, 3);
    assert.equal(result.events[0].action, 'clear');
});

test('blackboard skill discards LLM geometry and derives valid bounds for axis-aligned free arrows', async () => {
    const llmResult = () => ({
        events: [
            {
                action: 'create',
                target: { type: 'blackboard' },
                payload: { widget: { type: 'line', properties: {
                    geometry: { x: 640, y: 150, width: 160, height: 0, rotation: 0 },
                    line: { x1: 640, y1: 150, x2: 800, y2: 150, markerEnd: 'arrow' },
                } } },
            },
            {
                action: 'create',
                target: { type: 'blackboard' },
                payload: { widget: { type: 'line', properties: {
                    geometry: { x: 900, y: 200, width: 0, height: 120, rotation: 0 },
                    line: { x1: 900, y1: 200, x2: 900, y2: 320, markerEnd: 'arrow' },
                } } },
            },
        ],
    });
    const result = await interpretBlackboardSkill({
        promptText: 'draw an arrow to the right of the circle',
        context: { board: { widgets: [] } },
        llmAgent: { executeStructuredPrompt: async () => llmResult() },
    });

    const properties = result.events[0].payload.widget.properties;
    assert.equal(Object.hasOwn(properties, 'geometry'), false);
    assert.deepEqual(properties.line, { x1: 640, y1: 150, x2: 800, y2: 150, markerEnd: 'arrow' });

    const widget = new BlackboardWidget({ id: 'arrow-1', type: 'line', properties });
    assert.deepEqual(widget.properties.geometry, { x: 639.5, y: 149.5, width: 161, height: 1, rotation: 0 });
    assert.equal(widget.properties.line.markerEnd, 'arrow');

    const verticalProperties = result.events[1].payload.widget.properties;
    assert.equal(Object.hasOwn(verticalProperties, 'geometry'), false);
    const verticalWidget = new BlackboardWidget({ id: 'arrow-2', type: 'line', properties: verticalProperties });
    assert.deepEqual(verticalWidget.properties.geometry, { x: 899.5, y: 199.5, width: 1, height: 121, rotation: 0 });
    assert.equal(verticalWidget.properties.line.markerEnd, 'arrow');
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
    assert.equal(semantic.widgets[0].rotation, 0);
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
    assert.match(prompt, /Rotate by N degrees/);
});

test('blackboard skill gives displayed ordinals priority in compact speech commands', async () => {
    const prompts = [];
    const lineOneUpdate = { events: [{
        action: 'update',
        target: { type: 'widget', widgetId: 'line-1' },
        payload: { patch: { properties: { geometryDelta: { x: 0, y: 100 } } } },
    }] };
    const result = await interpretBlackboardSkill({
        promptText: 'move line one hundred pixels down',
        context: { board: {
            focusedWidgetId: null,
            lastAffectedWidgetIds: [],
            widgets: [
                { id: 'line-1', ordinal: 1, type: 'line', line: { x1: 0, y1: 0, x2: 100, y2: 0 } },
                { id: 'line-2', ordinal: 2, type: 'line', line: { x1: 0, y1: 200, x2: 100, y2: 200 } },
            ],
        } },
        llmAgent: {
            executePrompt: async (prompt) => {
                prompts.push(prompt);
                return lineOneUpdate;
            },
        },
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /move line one hundred pixels down.*line ordinal 1 moved down by 100 pixels/);
    assert.equal(result.events[0].target.widgetId, 'line-1');
    assert.deepEqual(result.events[0].payload.patch.properties.geometryDelta, { x: 0, y: 100 });
});

test('semantic context exposes canonical widget rotation for relative rotation commands', () => {
    const semantic = buildSemanticBoardContext({
        widgets: [{ id: 'line-1', type: 'line', properties: {
            rotation: 30,
            geometry: { x: 10, y: 10, width: 100, height: 2 },
            line: { x1: 0, y1: 1, x2: 100, y2: 1 },
        } }],
        interactionContext: { focusedWidgetId: 'line-1', lastAffectedWidgetIds: ['line-1'] },
    });
    assert.equal(semantic.widgets[0].rotation, 30);
});

test('SCRIPTA semantic context exposes safe active focus and uses it when no ordinal is supplied', async () => {
    const semantic = buildSemanticBoardContext({
        interactionContext: { focusedWidgetId: 'line-1', lastAffectedWidgetIds: ['line-1'] },
        widgets: [
            { id: 'line-1', type: 'line', properties: { line: { x1: 0, y1: 0, x2: 100, y2: 0 } } },
            { id: 'robo_scripta_document', type: 'scripta-document', properties: {
                resourceId: 'resource-1',
                documentTitle: 'Draft',
                viewMode: 'document',
                focusedChapterId: 'chapter-1',
                focusedParagraphId: 'paragraph-1',
                focusTargetType: 'paragraph',
                chapters: [{
                    chapterId: 'chapter-1', chapterOrdinal: 1, chapterTitle: 'Chapter 1',
                    paragraphs: [{ paragraphId: 'paragraph-1', paragraphOrdinal: 1, text: 'private content' }],
                }],
            } },
        ],
    });
    const scriptaWidget = semantic.widgets[1];
    assert.deepEqual(scriptaWidget.scripta, {
        activeResourceId: 'resource-1',
        documentTitle: 'Draft',
        view: {
            mode: 'document', focusTargetType: 'paragraph',
            chapterId: 'chapter-1', chapterOrdinal: 1,
            paragraphId: 'paragraph-1', paragraphOrdinal: 1,
        },
        documentOutline: [{
            chapterId: 'chapter-1', ordinal: 1, title: 'Chapter 1',
            paragraphs: [{ paragraphId: 'paragraph-1', ordinal: 1 }],
        }],
    });
    assert.equal(JSON.stringify(scriptaWidget.scripta).includes('private content'), false);
    assert.ok(scriptaWidget.capabilities.domainActions.includes('scripta-chapter-edit'));
    assert.equal(semantic.widgets[0].capabilities.groupable, true);
    assert.equal(scriptaWidget.capabilities.groupable, false);

    const prompts = [];
    const renameFocusedChapter = { events: [{
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { title: 'test' },
    }] };
    const result = await interpretBlackboardSkill({
        promptText: 'edit chapter rename it to test',
        context: { board: semantic },
        llmAgent: { executePrompt: async (prompt) => {
            prompts.push(prompt);
            return renameFocusedChapter;
        } },
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /focused paragraph also identifies its containing chapter/);
    assert.match(prompts[0], /Absence of an ordinal is not ambiguous when a compatible focus exists/);
    assert.equal(result.events[0].action, 'scripta-chapter-edit');
    assert.equal(result.events[0].payload.title, 'test');
});

test('blackboard skill repairs a nested SCRIPTA mutation into the canonical flat payload', async () => {
    const malformed = { events: [{
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { mutation: { resourceId: 'resource-1', chapterOrdinal: 1, title: 'test' } },
    }] };
    const canonical = { events: [{
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { resourceId: 'resource-1', chapterOrdinal: 1, title: 'test' },
    }] };
    const wrongOperationField = { events: [{
        action: 'scripta-chapter-edit',
        target: { type: 'widget', widgetId: 'robo_scripta_document' },
        payload: { resourceId: 'resource-1', chapterOrdinal: 1, type: 'chapter-rename', title: 'test' },
    }] };
    const responses = [malformed, wrongOperationField, canonical, canonical];
    const prompts = [];
    const result = await interpretBlackboardSkill({
        promptText: 'rename chapter 1 to test',
        context: { board: { widgets: [{
            id: 'robo_scripta_document', type: 'scripta-document',
            scripta: { activeResourceId: 'resource-1', view: { chapterId: 'chapter-1', chapterOrdinal: 1 } },
        }] } },
        llmAgent: { executePrompt: async (prompt) => {
            prompts.push(prompt);
            return responses.shift();
        } },
    });
    assert.equal(prompts.length, 4);
    assert.match(prompts[1], /unsupported fields: mutation/);
    assert.match(prompts[2], /unsupported fields: type/);
    assert.match(prompts[0], /Never put an operation name in payload\.type/);
    assert.deepEqual(result.events[0].payload, {
        resourceId: 'resource-1', chapterOrdinal: 1, title: 'test',
    });
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
    assert.equal(widget.properties.geometry.x, 699.5);
    assert.equal(widget.properties.geometry.y, 399.5);
    assert.equal(widget.properties.geometry.rotation, 0);
    assert.ok(Math.abs(widget.properties.geometry.width - 71.710678) < 1e-9);
    assert.ok(Math.abs(widget.properties.geometry.height - 71.710678) < 1e-9);
    assert.equal(widget.properties.line.x1, 0.5);
    assert.equal(widget.properties.line.y1, 0.5);
    assert.ok(Math.abs(widget.properties.line.x2 - 71.210678) < 1e-9);
    assert.ok(Math.abs(widget.properties.line.y2 - 71.210678) < 1e-9);
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

test('canonical group targets move, resize, rotate, ungroup, and delete rigid blocks', () => {
    const moveEvent = normalizeBlackboardEvent({
        action: 'update',
        target: { type: 'group', groupId: 'group-1' },
        payload: { patch: { transform: { translation: { x: 10, y: 20 } } } },
    });
    assert.deepEqual(moveEvent.target, { type: 'group', groupId: 'group-1' });
    assert.throws(() => normalizeBlackboardEvent({
        action: 'update',
        target: { type: 'group', groupId: 'group-1' },
        payload: { patch: { properties: { geometryDelta: { x: 10, y: 20 } } } },
    }), /requires a transformation|unsupported fields/);

    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({ id: 'a', type: 'shape', properties: { geometry: { x: 0, y: 0, width: 100, height: 50 } } }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'b', type: 'shape', properties: { geometry: { x: 200, y: 0, width: 100, height: 50 } } }), { record: false });
    board.groupWidgets(['a', 'b'], { groupId: 'group-1', record: false });
    board.transformGroup('group-1', { translation: { x: 10, y: 20 } }, { record: false });
    assert.deepEqual(board.getWidget('a').properties.geometry, { x: 10, y: 20, width: 100, height: 50 });
    assert.deepEqual(board.getWidget('b').properties.geometry, { x: 210, y: 20, width: 100, height: 50 });

    board.transformGroup('group-1', { resize: { x: 0, y: 0, width: 600, height: 100 } }, { record: false });
    assert.deepEqual(board.getWidget('a').properties.geometry, { x: 0, y: 0, width: 200, height: 100 });
    assert.deepEqual(board.getWidget('b').properties.geometry, { x: 400, y: 0, width: 200, height: 100 });

    board.transformGroup('group-1', { rotationDelta: 90 }, { record: false });
    assert.ok(Math.abs(board.getWidget('a').properties.geometry.x - 200) < 1e-9);
    assert.ok(Math.abs(board.getWidget('a').properties.geometry.y + 200) < 1e-9);
    assert.ok(Math.abs(board.getWidget('b').properties.geometry.x - 200) < 1e-9);
    assert.ok(Math.abs(board.getWidget('b').properties.geometry.y - 200) < 1e-9);
    assert.equal(board.getWidget('a').properties.rotation, 90);
    assert.equal(board.getWidget('b').properties.rotation, 90);

    const members = board.ungroupGroup('group-1', { record: false });
    assert.deepEqual(members.map((widget) => widget.groupId), ['', '']);
});

test('group deletion removes every member and dependent attached connection atomically', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({ id: 'a', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'b', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'outside', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({
        id: 'edge',
        type: 'line',
        properties: { connection: { from: { widgetId: 'b', anchor: 'right' }, to: { widgetId: 'outside', anchor: 'left' } } },
    }), { record: false });
    board.groupWidgets(['a', 'b'], { groupId: 'group-1', record: false });
    const removed = board.removeGroup('group-1', { record: false });
    assert.deepEqual(new Set(removed.map((widget) => widget.id)), new Set(['a', 'b', 'edge']));
    assert.equal(board.getWidget('a'), null);
    assert.equal(board.getWidget('b'), null);
    assert.equal(board.getWidget('edge'), null);
    assert.ok(board.getWidget('outside'));
});

test('interactive widgets cannot be grouped', () => {
    for (const type of ['poll', 'bullets', 'embed', 'scripta-document']) {
        const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
        board.addWidget(new BlackboardWidget({ id: 'shape', type: 'shape' }), { record: false });
        board.addWidget(new BlackboardWidget({ id: 'interactive', type }), { record: false });

        assert.throws(
            () => board.applyFinalChange({ changeType: 'group', widgetIds: ['shape', 'interactive'] }),
            (error) => error?.code === 'widget_not_groupable' && /cannot be grouped/.test(error.message),
        );
        assert.equal(board.getWidget('shape').groupId, '');
        assert.equal(board.getWidget('interactive').groupId, '');
        assert.equal(board.history.undoStack.length, 0);
    }

    const loaded = new Blackboard({
        boardId: 'agent:agent_robo_team',
        widgets: [
            { id: 'shape', type: 'shape', groupId: 'invalid-group' },
            { id: 'poll', type: 'poll', groupId: 'invalid-group' },
        ],
    });
    assert.equal(loaded.getWidget('shape').groupId, '');
    assert.equal(loaded.getWidget('poll').groupId, '');
});

test('direct UI group mutations are atomic undo and redo history entries', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({
        id: 'a',
        type: 'shape',
        properties: { geometry: { x: 0, y: 0, width: 100, height: 50 } },
    }), { record: false });
    board.addWidget(new BlackboardWidget({
        id: 'b',
        type: 'shape',
        properties: { geometry: { x: 200, y: 0, width: 100, height: 50 } },
    }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'outside', type: 'shape' }), { record: false });
    board.addWidget(new BlackboardWidget({
        id: 'edge',
        type: 'line',
        properties: { connection: { from: { widgetId: 'b', anchor: 'right' }, to: { widgetId: 'outside', anchor: 'left' } } },
    }), { record: false });

    board.applyFinalChange({ changeType: 'group', widgetIds: ['a', 'b'] });
    const groupId = board.getWidget('a').groupId;
    assert.ok(groupId);
    assert.equal(board.history.undoStack.at(-1).operation, 'group');
    board.undo();
    assert.equal(board.getWidget('a').groupId, '');
    assert.equal(board.getWidget('b').groupId, '');
    board.redo();
    assert.equal(board.getWidget('a').groupId, groupId);
    assert.equal(board.getWidget('b').groupId, groupId);

    board.applyFinalChange({
        changeType: 'update',
        targetType: 'group',
        targetRef: groupId,
        patch: { transform: { translation: { x: 30, y: 20 } } },
    });
    assert.equal(board.history.undoStack.at(-1).operation, 'transformGroup');
    assert.equal(board.getWidget('a').properties.geometry.x, 30);
    board.undo();
    assert.equal(board.getWidget('a').properties.geometry.x, 0);
    board.redo();
    assert.equal(board.getWidget('a').properties.geometry.x, 30);

    board.applyFinalChange({ changeType: 'ungroup', targetType: 'group', targetRef: groupId });
    assert.equal(board.history.undoStack.at(-1).operation, 'ungroupGroup');
    assert.equal(board.getWidget('a').groupId, '');
    board.undo();
    assert.equal(board.getWidget('a').groupId, groupId);
    assert.equal(board.getWidget('b').groupId, groupId);

    board.applyFinalChange({ changeType: 'delete', targetType: 'group', targetRef: groupId });
    assert.equal(board.history.undoStack.at(-1).operation, 'deleteGroup');
    assert.equal(board.getWidget('a'), null);
    assert.equal(board.getWidget('b'), null);
    assert.equal(board.getWidget('edge'), null);
    board.undo();
    assert.equal(board.getWidget('a').groupId, groupId);
    assert.equal(board.getWidget('b').groupId, groupId);
    assert.ok(board.getWidget('edge'));
    board.redo();
    assert.equal(board.getWidget('a'), null);
    assert.equal(board.getWidget('b'), null);
    assert.equal(board.getWidget('edge'), null);
    assert.ok(board.getWidget('outside'));
});

test('attached connections join a group only with both endpoints and remain derived during transforms', () => {
    const board = new Blackboard({ boardId: 'agent:agent_robo_team' });
    board.addWidget(new BlackboardWidget({ id: 'from', type: 'shape', properties: { geometry: { x: 0, y: 0, width: 100, height: 50 } } }), { record: false });
    board.addWidget(new BlackboardWidget({ id: 'to', type: 'shape', properties: { geometry: { x: 200, y: 0, width: 100, height: 50 } } }), { record: false });
    board.addWidget(new BlackboardWidget({
        id: 'edge', type: 'line',
        properties: { connection: { from: { widgetId: 'from', anchor: 'right' }, to: { widgetId: 'to', anchor: 'left' } } },
    }), { record: false });
    assert.throws(() => board.groupWidgets(['from', 'edge'], { groupId: 'invalid' }), /both endpoint widgets/);
    board.groupWidgets(['from', 'to', 'edge'], { groupId: 'valid', record: false });
    board.transformGroup('valid', { translation: { x: 30, y: 40 } }, { record: false });
    assert.deepEqual(board.getWidget('from').properties.geometry, { x: 30, y: 40, width: 100, height: 50 });
    assert.deepEqual(board.getWidget('to').properties.geometry, { x: 230, y: 40, width: 100, height: 50 });
    assert.equal(board.getWidget('edge').properties.geometry, undefined);
    assert.deepEqual(board.getWidget('edge').properties.connection, {
        from: { widgetId: 'from', anchor: 'right' },
        to: { widgetId: 'to', anchor: 'left' },
    });
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
