import { DEFAULT_BLACKBOARD_BOARD_ID } from './service.mjs';
import {
    newEventId,
    normalizeBlackboardEventResult,
    parseEventInput,
} from './event-contract.mjs';
import { BlackboardCommandInterpreter } from './blackboard-command-interpreter.mjs';
import { buildSemanticBoardContext } from './semantic-context.mjs';
import { executeRoboCommand } from '../scripta/command-service.mjs';

const SCRIPTA_ACTIONS = new Set([
    'scripta-document-create', 'scripta-document-open', 'scripta-document-delete',
    'scripta-paragraph-open', 'scripta-document-view', 'scripta-paragraph-next', 'scripta-paragraph-previous',
    'scripta-p-variant-add', 'scripta-p-variant-select', 'scripta-p-variant-edit-start',
    'scripta-p-variant-edit-cancel', 'scripta-p-variant-edit', 'scripta-p-variant-delete',
    'scripta-p-variant-vote', 'scripta-p-variant-vote-withdraw', 'scripta-p-variant-reformulate',
    'scripta-undo', 'scripta-chapter-add', 'scripta-chapter-edit', 'scripta-chapter-delete',
    'scripta-chapter-move', 'scripta-paragraph-add', 'scripta-paragraph-delete', 'scripta-paragraph-move',
]);

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (['path', 'folderPath', 'editorUrl', 'privateRoboContext', 'eventId', 'commandId', 'revision', 'version', 'expectedBoardVersion'].includes(key)) return [];
        if (['createdBy', 'updatedBy', 'requestedBy', 'executor', 'participantId', 'provenance'].includes(key)) return [];
        return [[key, redact(entry)]];
    }));
}

function auditPendingText(source, eventInput) {
    const parsed = source === 'robo' ? null : parseEventInput(eventInput);
    if (!parsed) return source === 'robo' ? '/robo [natural command]' : '/event [natural command]';
    return `${source === 'robo' ? '/robo' : '/event'} ${JSON.stringify(redact(parsed))}`;
}

function canonicalAuditText(events) {
    return events.map((event) => {
        const safe = redact(event);
        const payload = safe.payload && Object.keys(safe.payload).length ? ` ${JSON.stringify(safe.payload)}` : '';
        return `/event ${safe.action}${payload}`;
    }).join('\n');
}

function publicError(error) {
    return { code: String(error?.code || 'event_failed'), message: String(error?.message || 'Blackboard event failed.') };
}

function summarize(result) {
    return {
        ok: result?.ok !== false,
        mutated: result?.mutated !== false,
        boardRevision: Number(result?.blackboard?.revision || 0),
    };
}

function scriptaIntent(event) {
    const action = event.action.replace(/^scripta-/, '');
    const operation = action
        .replace('chapter-edit', 'chapter-rename')
        .replace('document-create', 'document-create')
        .replace('document-open', 'document-open')
        .replace('document-delete', 'document-delete');
    const focusActions = new Set(['paragraph-open', 'document-view', 'p-variant-select', 'p-variant-edit-start', 'p-variant-edit-cancel']);
    const navigationActions = new Set(['paragraph-next', 'paragraph-previous']);
    return {
        ...event.payload,
        kind: focusActions.has(action) ? 'focus' : navigationActions.has(action) ? 'navigation' : action === 'p-variant-reformulate' ? 'ai-reformulate' : action.startsWith('document-') ? 'document' : 'mutation',
        operation,
        ...(action === 'paragraph-next' ? { direction: 'next' } : {}),
        ...(action === 'paragraph-previous' ? { direction: 'previous' } : {}),
    };
}

async function updateAudit(deps, context, roomId, authInfo, audit, status, extras = {}, message = audit.message) {
    return (await deps.updateMeetingChat(context, {
        meetingId: roomId,
        messageId: audit.id,
        message,
        metadata: { ...audit.metadata, status, ...extras },
        authInfo,
    })).message;
}

async function interpret(deps, text, board) {
    if (deps.interpretBlackboardCommand) {
        const result = await deps.interpretBlackboardCommand(text, {
            instruction: String(text || ''),
            board: buildSemanticBoardContext(board),
        });
        return normalizeBlackboardEventResult(result);
    }
    return new BlackboardCommandInterpreter(deps.interpreterDeps).interpret({ text, board });
}

async function executeEvents(deps, context, input, events) {
    if (events.length === 1 && ['show', 'hide'].includes(events[0].action)) {
        return {
            ok: true,
            mutated: false,
            visibilityPayload: {
                type: 'blackboard.visibility_changed',
                meetingId: input.roomId,
                participantId: input.participantId,
                visible: events[0].action === 'show',
                boardId: DEFAULT_BLACKBOARD_BOARD_ID,
            },
        };
    }
    if (events.some((event) => SCRIPTA_ACTIONS.has(event.action))) {
        if (events.length !== 1) throw new Error('SCRIPTA events cannot be combined with generic blackboard events.');
        return executeRoboCommand(context, {
            roomId: input.roomId,
            text: /^\/robo(?:\s|$)/i.test(String(input.eventInput || ''))
                ? input.eventInput
                : `/robo ${String(input.eventInput || '')}`,
            source: input.commandSource,
            participantId: input.participantId,
            authInfo: input.authInfo,
        }, { intent: scriptaIntent(events[0]), reformulate: deps.reformulate });
    }
    if (typeof deps.applyRoomBlackboardEvents !== 'function') {
        throw new Error('Atomic blackboard event execution is unavailable.');
    }
    return deps.applyRoomBlackboardEvents(context, {
        roomId: input.roomId,
        boardId: DEFAULT_BLACKBOARD_BOARD_ID,
        events,
        participantId: input.participantId,
        authInfo: input.authInfo,
        source: input.source,
    });
}

export async function executeBlackboardEvent(context, args = {}, deps = {}) {
    const roomId = String(args.roomId || '').trim();
    if (!roomId) throw new Error('Missing required roomId.');
    const source = String(args.source || 'event').trim().toLowerCase();
    if (!['event', 'robo', 'ui'].includes(source)) throw new Error('source must be "event", "robo", or "ui".');
    const commandSource = String(args.commandSource || 'chat').trim().toLowerCase();
    if (!['chat', 'voice'].includes(commandSource)) throw new Error('commandSource must be "chat" or "voice".');
    if (typeof deps.authorizeRoomParticipant !== 'function') throw new Error('Blackboard event participant authorization is unavailable.');
    const authorization = await deps.authorizeRoomParticipant(context, { roomId, participantId: args.participantId, authInfo: args.authInfo });
    const participantId = String(authorization?.participantId || '').trim();
    if (!participantId) throw new Error('Blackboard event participant authorization returned no participant.');

    const boardResult = await deps.getRoomBlackboard(context, {
        roomId,
        boardId: DEFAULT_BLACKBOARD_BOARD_ID,
        participantId,
        authInfo: args.authInfo,
    });
    if (args.clarificationResponse !== undefined) {
        throw new Error('Blackboard clarification responses are not supported. Submit a complete new command.');
    }
    const eventInput = args.event;
    const commandId = String(args.commandId || '').trim() || newEventId('command');
    const appended = await deps.appendMeetingChat(context, {
        meetingId: roomId,
        authorId: participantId,
        authorName: args.authorName || 'Participant',
        message: auditPendingText(source, eventInput),
        kind: 'event',
        metadata: { status: 'pending', commandId, source },
        dedupeCommandId: commandId,
        authInfo: args.authInfo,
    });
    const audit = appended.message;
    if (appended.deduplicated) {
        return { ok: audit.metadata?.status === 'success', deduplicated: true, auditMessage: audit };
    }

    try {
        const parsed = source === 'robo' ? null : parseEventInput(eventInput);
        const interpreted = parsed
            ? normalizeBlackboardEventResult(parsed, { widgetId: args.selectedWidgetId }, { allowInternal: source === 'ui' })
            : await interpret(deps, eventInput, boardResult.blackboard);
        if (interpreted.error) {
            const semanticFailure = new Error(interpreted.error.message);
            semanticFailure.code = interpreted.error.code;
            throw semanticFailure;
        }
        const executionSource = parsed ? source : 'robo';
        const result = await executeEvents(deps, context, {
            roomId,
            participantId,
            authInfo: args.authInfo,
            source: executionSource,
            commandSource,
            eventInput,
        }, interpreted.events);
        const auditMessage = await updateAudit(deps, context, roomId, args.authInfo, audit, 'success', { events: redact(interpreted.events), result: summarize(result) }, canonicalAuditText(interpreted.events));
        return { ok: result?.ok !== false, events: interpreted.events, ...result, auditMessage };
    } catch (error) {
        const failure = publicError(error);
        const auditMessage = await updateAudit(deps, context, roomId, args.authInfo, audit, 'error', { error: failure });
        return { ok: false, error: failure, auditMessage };
    }
}
