import {
    DEFAULT_BLACKBOARD_BOARD_ID
} from './service.mjs';
import {
    newEventId,
    normalizeBlackboardEvent,
    parseEventInput
} from './event-contract.mjs';
import { interpretBlackboardEvent } from './event-interpreter.mjs';
import { executeRoboCommand } from '../scripta/command-service.mjs';

const SCRIPTA_ACTIONS = new Set([
    'scripta-document-create', 'scripta-document-open', 'scripta-document-delete',
    'scripta-paragraph-open', 'scripta-document-view', 'scripta-paragraph-next', 'scripta-paragraph-previous',
    'scripta-p-variant-add', 'scripta-p-variant-select',
    'scripta-p-variant-edit-start', 'scripta-p-variant-edit-cancel',
    'scripta-p-variant-edit', 'scripta-p-variant-delete',
    'scripta-p-variant-vote', 'scripta-p-variant-vote-withdraw', 'scripta-p-variant-reformulate',
    'scripta-undo',
    'scripta-chapter-add', 'scripta-chapter-edit', 'scripta-chapter-delete',
    'scripta-chapter-move', 'scripta-paragraph-add',
    'scripta-paragraph-delete', 'scripta-paragraph-move'
]);

function eventIntent(event) {
    if (event.payload.intent && typeof event.payload.intent === 'object') return event.payload.intent;
    const base = {
        resourceId: event.payload.resourceId,
        chapterId: event.payload.chapterId,
        paragraphId: event.payload.paragraphId,
        variantId: event.payload.variantId,
        chapterOrdinal: event.payload.chapterOrdinal,
        paragraphOrdinal: event.payload.paragraphOrdinal,
        targetChapterOrdinal: event.payload.targetChapterOrdinal,
        targetIndex: event.payload.targetIndex,
        variantOrdinal: event.payload.variantOrdinal,
        text: event.payload.text,
        title: event.payload.title,
        name: event.payload.name,
        path: event.payload.path,
        folderPath: event.payload.folderPath,
        template: event.payload.template,
        objective: event.payload.objective,
        visionParagraphs: event.payload.visionParagraphs,
        planParagraphs: event.payload.planParagraphs,
        chapters: event.payload.chapters,
        confirmed: event.payload.confirmed === true,
        type: event.payload.type,
        current: event.payload.current === true,
        editing: event.payload.editing
    };
    const mappings = {
        'scripta-document-create': { kind: 'document', operation: 'document-create' },
        'scripta-document-open': { kind: 'document', operation: 'document-open' },
        'scripta-document-delete': { kind: 'document', operation: 'document-delete' },
        'scripta-paragraph-open': { kind: 'focus', mode: 'paragraph' },
        'scripta-document-view': { kind: 'focus', mode: 'document' },
        'scripta-paragraph-next': { kind: 'navigation', direction: 'next' },
        'scripta-paragraph-previous': { kind: 'navigation', direction: 'previous' },
        'scripta-p-variant-add': { kind: 'mutation', operation: 'p-variant-add' },
        'scripta-p-variant-select': { kind: 'focus', mode: 'paragraph' },
        'scripta-p-variant-edit-start': { kind: 'focus', mode: 'paragraph', editing: true },
        'scripta-p-variant-edit-cancel': { kind: 'focus', mode: 'paragraph', editing: false },
        'scripta-p-variant-vote': { kind: 'mutation', operation: 'p-variant-vote' },
        'scripta-p-variant-vote-withdraw': { kind: 'mutation', operation: 'p-variant-vote-withdraw' },
        'scripta-p-variant-reformulate': { kind: 'ai-reformulate' },
        'scripta-p-variant-edit': { kind: 'mutation', operation: 'p-variant-edit' },
        'scripta-p-variant-delete': { kind: 'mutation', operation: 'p-variant-delete' },
        'scripta-undo': { kind: 'mutation', operation: 'undo' },
        'scripta-chapter-add': { kind: 'mutation', operation: 'chapter-add' },
        'scripta-chapter-edit': { kind: 'mutation', operation: 'chapter-rename' },
        'scripta-chapter-delete': { kind: 'mutation', operation: 'chapter-delete' },
        'scripta-chapter-move': { kind: 'mutation', operation: 'chapter-move' },
        'scripta-paragraph-add': { kind: 'mutation', operation: 'paragraph-add' },
        'scripta-paragraph-delete': { kind: 'mutation', operation: 'paragraph-delete' },
        'scripta-paragraph-move': { kind: 'mutation', operation: 'paragraph-move' }
    };
    return { ...base, ...mappings[event.action] };
}

function changeFromEvent(event) {
    if (event.payload.change && typeof event.payload.change === 'object') {
        const change = structuredClone(event.payload.change);
        const aliases = event.action === 'create' ? new Set(['create', 'add']) : new Set([event.action]);
        if (!aliases.has(String(change.changeType || '').trim())) {
            throw new Error(`Event action "${event.action}" does not match payload.change.changeType.`);
        }
        change.targetType = event.target.type;
        change.targetRef = event.target.widgetId || '';
        if (event.action === 'create' && change.widget?.id !== event.target.widgetId) {
            throw new Error('Created widget id must match event target.widgetId.');
        }
        return change;
    }
    if (event.action === 'clear') return { changeType: 'clear', targetType: 'blackboard', reason: event.payload.reason || 'event' };
    const changeType = event.action === 'create' ? 'add' : event.action;
    return {
        changeType,
        targetType: event.target.type,
        targetRef: event.target.widgetId || '',
        reason: event.payload.reason || 'event',
        widget: event.payload.widget,
        object: event.payload.object,
        patch: event.payload.patch,
        data: event.payload.data
    };
}

function redactAuditValue(value) {
    if (Array.isArray(value)) return value.map((entry) => redactAuditValue(entry));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => (
        ['path', 'folderPath', 'editorUrl'].includes(key)
            ? [key, '[private]']
            : [key, redactAuditValue(entry)]
    )));
}

function auditText(source, eventInput) {
    const parsed = parseEventInput(eventInput);
    if (parsed) {
        const prefix = source === 'robo' ? '/robo ' : '/event ';
        return `${prefix}${JSON.stringify(redactAuditValue(parsed))}`;
    }
    return source === 'robo'
        ? '/robo [natural command pending interpretation]'
        : '/event [natural command pending interpretation]';
}

function canonicalAuditText(event) {
    const safe = redactAuditValue(event);
    const payload = safe?.payload && typeof safe.payload === 'object' ? safe.payload : {};
    const payloadText = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : '';
    return `/event ${String(safe?.action || 'unknown')}${payloadText}`;
}

function publicError(error) {
    return {
        code: String(error?.code || 'event_failed'),
        message: String(error?.message || 'Blackboard event failed.'),
        ...(error?.currentBoardVersion !== undefined ? { currentBoardVersion: error.currentBoardVersion } : {}),
        ...(error?.documentCreated === true ? { documentCreated: true } : {}),
        ...(error?.attached === false ? { attached: false } : {}),
        ...(error?.resourceId ? { resourceId: String(error.resourceId) } : {}),
        ...(error?.documentName ? { documentName: String(error.documentName) } : {})
    };
}

function summarizeResult(result) {
    return {
        ok: result?.ok !== false,
        mutated: result?.mutated !== false,
        boardVersion: Number(result?.blackboard?.version || 0),
        clarificationRequired: result?.clarificationRequired === true,
        ...(result?.message ? { message: String(result.message) } : {})
    };
}

function hasCompleteEventRouting(candidate) {
    return Boolean(
        candidate
        && candidate.expectedBoardVersion !== undefined
        && candidate.expectedBoardVersion !== null
        && candidate.target?.boardId
        && candidate.target?.type
    );
}

async function buildInterpretationContext(deps, context, input, { includeScripta = true } = {}) {
    const boardResult = await deps.getRoomBlackboard(context, {
        roomId: input.roomId,
        boardId: DEFAULT_BLACKBOARD_BOARD_ID,
        participantId: input.participantId,
        authInfo: input.authInfo
    });
    const board = boardResult.blackboard;
    const selectedWidget = board.widgets?.find((widget) => widget.id === input.selectedWidgetId) || null;
    let scripta = null;
    if (includeScripta) {
        try {
            scripta = await deps.getScriptaContext(context, {
                roomId: input.roomId,
                participantId: input.participantId,
                authInfo: input.authInfo
            });
        } catch {
            scripta = null;
        }
    }
    return {
        board: { id: board.id, boardId: board.boardId, version: board.version, widgets: board.widgets },
        selectedWidget,
        scripta,
        commandId: input.commandId,
        eventId: input.eventId
    };
}

async function executeCanonicalEvent(deps, context, input, event) {
    const common = {
        roomId: input.roomId,
        boardId: event.target.boardId,
        participantId: input.participantId,
        authInfo: input.authInfo,
        expectedBoardVersion: event.expectedBoardVersion
    };
    if (event.action === 'undo') return deps.undoRoomBlackboard(context, common);
    if (event.action === 'redo') return deps.redoRoomBlackboard(context, common);
    if (event.action === 'show' || event.action === 'hide') {
        return {
            ok: true,
            visibilityPayload: {
                type: 'blackboard.visibility_changed',
                meetingId: input.roomId,
                participantId: input.participantId,
                presenterName: input.authorName || input.participantId,
                visible: event.action === 'show',
                boardId: event.target.boardId
            }
        };
    }
    if (SCRIPTA_ACTIONS.has(event.action)) {
        return executeRoboCommand(context, {
            roomId: input.roomId,
            text: input.source === 'robo' ? input.eventInput : `/robo ${input.eventInput}`,
            source: input.commandSource,
            participantId: input.participantId,
            authInfo: input.authInfo,
            expectedBoardVersion: event.expectedBoardVersion
        }, {
            intent: eventIntent(event),
            reformulate: deps.reformulate
        });
    }
    return deps.applyRoomBlackboardChange(context, { ...common, change: changeFromEvent(event) });
}

export async function executeBlackboardEvent(context, args = {}, deps = {}) {
    const roomId = String(args.roomId || '').trim();
    if (!roomId) throw new Error('Missing required roomId.');
    const source = String(args.source || 'event').trim().toLowerCase();
    if (!['event', 'robo', 'ui'].includes(source)) throw new Error('source must be "event", "robo", or "ui".');
    const commandSource = String(args.commandSource || 'chat').trim().toLowerCase();
    if (!['chat', 'voice'].includes(commandSource)) throw new Error('commandSource must be "chat" or "voice".');
    const commandId = String(args.commandId || '').trim() || newEventId('command');
    const eventId = newEventId();
    const eventInput = args.event;
    if (typeof deps.authorizeRoomParticipant !== 'function') {
        throw new Error('Blackboard event participant authorization is unavailable.');
    }
    const authorization = await deps.authorizeRoomParticipant(context, {
        roomId,
        participantId: args.participantId,
        authInfo: args.authInfo,
    });
    const participantId = String(authorization?.participantId || '').trim();
    if (!participantId) throw new Error('Blackboard event participant authorization returned no participant.');
    const authorizedArgs = { ...args, participantId };
    const audit = await deps.appendMeetingChat(context, {
        meetingId: roomId,
        authorId: participantId,
        authorName: args.authorName || 'Participant',
        message: auditText(source, eventInput),
        kind: 'event',
        metadata: { status: 'pending', commandId, source, eventId },
        dedupeCommandId: commandId,
        authInfo: args.authInfo
    });
    if (audit.deduplicated) {
        return { ok: audit.message.metadata?.status === 'success', deduplicated: true, auditMessage: audit.message };
    }
    try {
        let candidate = parseEventInput(eventInput);
        const interpretationContext = hasCompleteEventRouting(candidate)
            ? {
                board: {
                    id: candidate.target.boardId,
                    boardId: candidate.target.boardId,
                    version: Number(candidate.expectedBoardVersion),
                    widgets: [],
                },
                selectedWidget: null,
                scripta: null,
                commandId,
                eventId,
            }
            : await buildInterpretationContext(deps, context, {
                ...authorizedArgs, roomId, commandId, eventId
            }, {
                // Semantic /event commands still need board routing defaults.
                // Fully-routed UI events and canonical JSON already carry
                // them, while natural language additionally needs SCRIPTA.
                includeScripta: !candidate
            });
        if (!candidate) {
            candidate = await (deps.interpretBlackboardEvent || interpretBlackboardEvent)(eventInput, interpretationContext);
        }
        if (candidate?.clarificationRequired) {
            const result = { ok: false, clarificationRequired: true, message: String(candidate.message || 'Please clarify the requested blackboard action.'), mutated: false };
            const updated = await deps.updateMeetingChat(context, {
                meetingId: roomId,
                messageId: audit.message.id,
                message: audit.message.message,
                metadata: { ...audit.message.metadata, status: 'success', result: summarizeResult(result) },
                authInfo: args.authInfo
            });
            return { ...result, auditMessage: updated.message };
        }
        const event = normalizeBlackboardEvent(candidate, {
            boardId: interpretationContext.board.boardId,
            widgetId: args.selectedWidgetId,
            expectedBoardVersion: interpretationContext.board.version,
            commandId,
            eventId
        });
        const result = await executeCanonicalEvent(deps, context, {
            ...authorizedArgs, roomId, source, commandSource, commandId, eventId, eventInput
        }, event);
        const updated = await deps.updateMeetingChat(context, {
            meetingId: roomId,
            messageId: audit.message.id,
            message: canonicalAuditText(event),
            metadata: {
                ...audit.message.metadata,
                status: 'success',
                event: redactAuditValue(event),
                result: summarizeResult(result),
            },
            authInfo: args.authInfo
        });
        return { ok: result?.ok !== false, event, ...result, auditMessage: updated.message };
    } catch (error) {
        const failure = publicError(error);
        const updated = await deps.updateMeetingChat(context, {
            meetingId: roomId,
            messageId: audit.message.id,
            message: audit.message.message,
            metadata: { ...audit.message.metadata, status: 'error', error: failure },
            authInfo: args.authInfo
        });
        return { ok: false, error: failure, auditMessage: updated.message };
    }
}
