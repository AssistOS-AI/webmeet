import test from 'node:test';
import assert from 'node:assert/strict';

import { executeBlackboardEvent } from '../../lib/blackboard/event-service.mjs';
import { normalizeBlackboardEvent, parseEventInput } from '../../lib/blackboard/event-contract.mjs';
import { interpretBlackboardEvent } from '../../lib/blackboard/event-interpreter.mjs';
import { generateScriptaContent } from '../../lib/scripta/content-generator.mjs';

function canonical(overrides = {}) {
    return {
        eventId: 'event-1',
        commandId: 'command-1',
        expectedBoardVersion: 7,
        target: { type: 'widget', boardId: 'agent:agent_robo_team', widgetId: 'widget-1' },
        action: 'update',
        payload: { change: { changeType: 'update', targetType: 'widget', targetRef: 'widget-1', patch: { title: 'Next' } } },
        ...overrides
    };
}

function makeDeps(overrides = {}) {
    let auditMessage = null;
    return {
        authorizeRoomParticipant: async (_context, input) => ({
            participantId: input.participantId,
        }),
        appendMeetingChat: async (_context, input) => {
            auditMessage = { id: 'chat-event-1', message: input.message, kind: input.kind, metadata: input.metadata };
            return { message: auditMessage, deduplicated: false };
        },
        updateMeetingChat: async (_context, input) => {
            auditMessage = { ...auditMessage, message: input.message, metadata: input.metadata };
            return { message: auditMessage };
        },
        getRoomBlackboard: async () => ({ blackboard: { id: 'board', boardId: 'agent:agent_robo_team', version: 7, widgets: [] } }),
        getScriptaContext: async () => { throw new Error('not initialized'); },
        applyRoomBlackboardChange: async (_context, input) => ({
            ok: true,
            blackboard: { version: 8, widgets: [] },
            object: { id: 'widget-1' },
            change: input.change
        }),
        undoRoomBlackboard: async () => ({ changed: true, blackboard: { version: 8 } }),
        redoRoomBlackboard: async () => ({ changed: true, blackboard: { version: 8 } }),
        ...overrides
    };
}

test('canonical JSON bypasses interpretation and uses the board version precondition', async () => {
    let applied = null;
    let boardReads = 0;
    const deps = makeDeps({
        interpretBlackboardEvent: async () => { throw new Error('must not interpret JSON'); },
        getRoomBlackboard: async () => {
            boardReads += 1;
            throw new Error('fully routed JSON must not reload the board');
        },
        applyRoomBlackboardChange: async (_context, input) => {
            applied = input;
            return { ok: true, blackboard: { version: 8 }, change: input.change };
        }
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-1',
        event: JSON.stringify(canonical()),
        source: 'event',
        participantId: 'participant-1',
        authorName: 'One',
        authInfo: {}
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(applied.expectedBoardVersion, 7);
    assert.equal(result.auditMessage.kind, 'event');
    assert.equal(result.auditMessage.metadata.status, 'success');
    assert.equal(result.auditMessage.metadata.result.boardVersion, 8);
    assert.equal(boardReads, 0);
});

test('event audit and execution use the participant authorized before persistence', async () => {
    let auditedAuthorId = '';
    let appliedParticipantId = '';
    const deps = makeDeps({
        authorizeRoomParticipant: async () => ({ participantId: 'participant-authorized' }),
        appendMeetingChat: async (_context, input) => {
            auditedAuthorId = input.authorId;
            return {
                message: {
                    id: 'chat-event-authorized',
                    message: input.message,
                    kind: input.kind,
                    metadata: input.metadata,
                },
                deduplicated: false,
            };
        },
        applyRoomBlackboardChange: async (_context, input) => {
            appliedParticipantId = input.participantId;
            return { ok: true, blackboard: { version: 8 }, change: input.change };
        },
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-1',
        event: JSON.stringify(canonical()),
        source: 'event',
        participantId: 'participant-forged',
        authInfo: {},
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(auditedAuthorId, 'participant-authorized');
    assert.equal(appliedParticipantId, 'participant-authorized');
});

test('participant authorization failure creates no pending audit message', async () => {
    let auditCalls = 0;
    const deps = makeDeps({
        authorizeRoomParticipant: async () => {
            throw new Error('Access denied: cannot act as another participant.');
        },
        appendMeetingChat: async () => {
            auditCalls += 1;
            throw new Error('must not append');
        },
    });

    await assert.rejects(
        executeBlackboardEvent({}, {
            roomId: 'room-1',
            event: JSON.stringify(canonical()),
            source: 'event',
            participantId: 'participant-forged',
            authInfo: {},
        }, deps),
        /cannot act as another participant/,
    );
    assert.equal(auditCalls, 0);
});

test('event failures preserve safe partial SCRIPTA attachment status', async () => {
    const failure = new Error('Document created but attachment failed.');
    failure.code = 'scripta_attachment_failed';
    failure.documentCreated = true;
    failure.attached = false;
    failure.resourceId = 'resource-1';
    failure.documentName = 'draft.md';
    const deps = makeDeps({
        applyRoomBlackboardChange: async () => { throw failure; },
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-1',
        event: JSON.stringify(canonical()),
        source: 'event',
        participantId: 'participant-1',
        authInfo: {},
    }, deps);

    assert.equal(result.ok, false);
    assert.deepEqual(result.error, {
        code: 'scripta_attachment_failed',
        message: 'Document created but attachment failed.',
        documentCreated: true,
        attached: false,
        resourceId: 'resource-1',
        documentName: 'draft.md',
    });
});

test('semantic /event action and JSON payload bypass interpretation', async () => {
    let applied = null;
    const deps = makeDeps({
        interpretBlackboardEvent: async () => { throw new Error('must not interpret semantic events'); },
        applyRoomBlackboardChange: async (_context, input) => {
            applied = input;
            return { ok: true, blackboard: { version: 8 }, change: input.change };
        }
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-1',
        event: 'clear {"reason":"toolbar"}',
        source: 'event',
        participantId: 'participant-1',
        authInfo: {}
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(applied.change.changeType, 'clear');
    assert.equal(applied.change.reason, 'toolbar');
    assert.equal(result.auditMessage.metadata.status, 'success');
});

test('semantic SCRIPTA event parses the Debug command form without AI', () => {
    assert.deepEqual(
        parseEventInput('scripta-chapter-edit {"title":"Chapter 1 test zzzzzzz"}'),
        { action: 'scripta-chapter-edit', payload: { title: 'Chapter 1 test zzzzzzz' } }
    );
    assert.throws(
        () => parseEventInput('scripta-chapter-edit not-json'),
        /valid JSON object/
    );
});

test('natural text is interpreted once with a room-local safe projection', async () => {
    let receivedContext = null;
    const deps = makeDeps({
        interpretBlackboardEvent: async (_text, context) => {
            receivedContext = context;
            return canonical();
        }
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-2',
        event: 'move this widget',
        source: 'event',
        participantId: 'participant-2',
        selectedWidgetId: 'widget-1',
        authInfo: {}
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(receivedContext.board.version, 7);
    assert.equal(receivedContext.commandId.startsWith('command_'), true);
});

test('AI event interpretation has a bounded lifetime and shuts down its agent', async () => {
    let shutdown = false;
    class HangingAgent {
        executeSkill() {
            return new Promise(() => {});
        }

        shutdown() {
            shutdown = true;
        }
    }

    await assert.rejects(
        interpretBlackboardEvent('ambiguous natural command', {}, { MainAgent: HangingAgent, timeoutMs: 5 }),
        (error) => error.code === 'event_interpretation_timeout'
    );
    assert.equal(shutdown, true);
});

test('SCRIPTA content generation has a bounded lifetime and shuts down its agent', async () => {
    let shutdown = false;
    class HangingAgent {
        executeSkill() {
            return new Promise(() => {});
        }

        shutdown() {
            shutdown = true;
        }
    }

    await assert.rejects(
        generateScriptaContent({ task: 'create-scripta-document' }, {
            MainAgent: HangingAgent,
            timeoutMs: 5,
        }),
        (error) => error.code === 'scripta_content_timeout'
    );
    assert.equal(shutdown, true);
});

test('event validation rejects missing optimistic concurrency version', () => {
    assert.throws(() => normalizeBlackboardEvent({
        eventId: 'event',
        commandId: 'command',
        target: { type: 'blackboard', boardId: 'agent:agent_robo_team' },
        action: 'clear',
        payload: {}
    }), /expectedBoardVersion/);
});

test('deduplicated commandId does not execute a second mutation', async () => {
    let mutations = 0;
    const existing = { id: 'chat-existing', kind: 'event', message: '/event {}', metadata: { commandId: 'same', status: 'success' } };
    const deps = makeDeps({
        appendMeetingChat: async () => ({ message: existing, deduplicated: true }),
        applyRoomBlackboardChange: async () => { mutations += 1; }
    });
    const result = await executeBlackboardEvent({}, {
        roomId: 'room-1', event: JSON.stringify(canonical()), source: 'event', commandId: 'same', participantId: 'p', authInfo: {}
    }, deps);
    assert.equal(result.deduplicated, true);
    assert.equal(mutations, 0);
});

test('event audit redacts workspace paths before chat persistence', async () => {
    let persistedMessage = '';
    const deps = makeDeps({
        appendMeetingChat: async (_context, input) => {
            persistedMessage = input.message;
            return { message: { id: 'audit', message: input.message, kind: 'event', metadata: input.metadata }, deduplicated: false };
        },
    });
    const event = canonical({ payload: {
        path: '/private/story.md',
        folderPath: '/private',
        change: { changeType: 'update', targetType: 'widget', targetRef: 'widget-1', patch: { title: 'Next' } },
    } });
    await executeBlackboardEvent({}, {
        roomId: 'room-1', event: JSON.stringify(event), source: 'ui', participantId: 'p', authInfo: {},
    }, deps);
    assert.equal(persistedMessage.includes('/private'), false);
    assert.match(persistedMessage, /\[private\]/);
});

test('natural command audit never persists the original workspace reference', async () => {
    const persistedMessages = [];
    let audit = null;
    const deps = makeDeps({
        appendMeetingChat: async (_context, input) => {
            persistedMessages.push(input.message);
            audit = { id: 'audit-natural', message: input.message, kind: 'event', metadata: input.metadata };
            return { message: audit, deduplicated: false };
        },
        updateMeetingChat: async (_context, input) => {
            persistedMessages.push(input.message);
            audit = { ...audit, message: input.message, metadata: input.metadata };
            return { message: audit };
        },
        interpretBlackboardEvent: async () => canonical({
            payload: {
                path: 'SecretProjects/private-film.md',
                change: {
                    changeType: 'update',
                    targetType: 'widget',
                    targetRef: 'widget-1',
                    patch: { title: 'Next' },
                },
            },
        }),
    });
    await executeBlackboardEvent({}, {
        roomId: 'room-1',
        event: 'open SecretProjects/private-film.md from folder SecretProjects',
        source: 'robo',
        participantId: 'p',
        authInfo: {},
    }, deps);

    assert.equal(persistedMessages.some((message) => message.includes('SecretProjects')), false);
    assert.match(persistedMessages.at(-1), /^\/event update/);
    assert.match(persistedMessages.at(-1), /\[private\]/);
});
