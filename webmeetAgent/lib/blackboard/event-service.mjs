import {
    newEventId,
    normalizeBlackboardEventResult,
    parseEventInput,
} from './event-contract.mjs';
import { BlackboardCommandInterpreter } from './blackboard-command-interpreter.mjs';
import { buildSemanticBoardContext, buildSemanticWorkspaceContext } from './semantic-context.mjs';
import { executeRoboCommand } from '../scripta/command-service.mjs';

const SCRIPTA_ACTIONS = new Set([
    'scripta-document-create', 'scripta-document-open', 'scripta-document-delete',
    'scripta-paragraph-open', 'scripta-document-view', 'scripta-paragraph-next', 'scripta-paragraph-previous',
    'scripta-p-variant-add', 'scripta-p-variant-select', 'scripta-p-variant-edit-start',
    'scripta-p-variant-edit-cancel', 'scripta-p-variant-edit', 'scripta-p-variant-delete',
    'scripta-p-variant-image-insert', 'scripta-p-variant-image-replace',
    'scripta-p-variant-image-delete', 'scripta-p-variant-image-layout',
    'scripta-p-variant-vote', 'scripta-p-variant-vote-withdraw', 'scripta-p-variant-reformulate',
    'scripta-undo', 'scripta-chapter-add', 'scripta-chapter-edit', 'scripta-chapter-delete',
    'scripta-chapter-move', 'scripta-paragraph-add', 'scripta-paragraph-delete', 'scripta-paragraph-move',
    'scripta-media-insert',
]);
const BOARD_ACTIONS = new Set(['board-create', 'board-rename', 'board-reorder', 'board-delete', 'board-activate', 'board-transfer', 'board-copy']);

function redact(value) {
    if (Array.isArray(value)) return value.map(redact);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
        if (['path', 'folderPath', 'editorUrl', 'privateRoboContext', 'eventId', 'commandId', 'revision', 'version', 'expectedBoardVersion',
            'resourceId', 'chapterId', 'paragraphId', 'variantId', 'imageId', 'assetId'].includes(key)) return [];
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

function workspaceBoardTitle(workspace, boardId = '') {
    const targetBoardId = String(boardId || '').trim();
    if (!targetBoardId || !Array.isArray(workspace?.boards)) return '';
    const index = workspace.boards.findIndex((board) => String(board?.boardId || '').trim() === targetBoardId);
    if (index < 0) return '';
    return String(workspace.boards[index]?.title || `Workspace ${index + 1}`).trim();
}

function initialAuditBoardContext(boardResult, boardId = '') {
    const targetBoardId = String(boardId || boardResult?.blackboard?.boardId || '').trim();
    return {
        boardId: targetBoardId,
        boardTitle: workspaceBoardTitle(boardResult?.workspace, targetBoardId)
            || String(boardResult?.blackboard?.metadata?.title || '').trim(),
    };
}

function finalAuditBoardContext(events, inputBoardId, boardResult, result) {
    const event = Array.isArray(events) && events.length === 1 ? events[0] : null;
    const action = String(event?.action || '').trim();
    let boardId = String(inputBoardId || '').trim();
    if (action === 'board-create') {
        boardId = String(result?.workspace?.activeBoardId || result?.blackboard?.boardId || boardId).trim();
    } else if (['board-rename', 'board-reorder', 'board-delete', 'board-activate'].includes(action)) {
        boardId = String(event?.payload?.targetBoardId || boardId).trim();
    }
    const boardTitle = workspaceBoardTitle(result?.workspace, boardId)
        || workspaceBoardTitle(boardResult?.workspace, boardId)
        || (String(result?.blackboard?.boardId || '').trim() === boardId
            ? String(result?.blackboard?.metadata?.title || '').trim()
            : '')
        || (String(boardResult?.blackboard?.boardId || '').trim() === boardId
            ? String(boardResult?.blackboard?.metadata?.title || '').trim()
            : '');
    return { boardId, boardTitle };
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

export function buildScriptaIntent(event) {
    const action = event.action.replace(/^scripta-/, '');
    const operation = action
        .replace('media-insert', 'p-variant-image-insert')
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
        ...(action === 'document-view' ? { mode: 'document' } : {}),
        ...(action === 'paragraph-open' ? { mode: 'paragraph' } : {}),
        ...(action === 'p-variant-edit-start' ? { editing: true } : {}),
        ...(action === 'p-variant-edit-cancel' ? { editing: false } : {}),
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

async function interpret(deps, text, board, workspace) {
    if (deps.interpretBlackboardCommand) {
        const result = await deps.interpretBlackboardCommand(text, {
            instruction: String(text || ''),
            board: buildSemanticBoardContext(board),
            workspace: buildSemanticWorkspaceContext(workspace),
        });
        return normalizeBlackboardEventResult(result);
    }
    return new BlackboardCommandInterpreter(deps.interpreterDeps).interpret({ text, board, workspace });
}

async function executeEvents(deps, context, input, events, board = null) {
    if (events.length === 1 && ['show', 'hide'].includes(events[0].action)) {
        return {
            ok: true,
            mutated: false,
            visibilityPayload: {
                type: 'blackboard.visibility_changed',
                meetingId: input.roomId,
                participantId: input.participantId,
                visible: events[0].action === 'show',
                boardId: input.boardId,
            },
        };
    }
    if (events.some((event) => SCRIPTA_ACTIONS.has(event.action))) {
        if (events.length !== 1) throw new Error('SCRIPTA events cannot be combined with generic blackboard events.');
        const event = events[0];
        if (event.action === 'scripta-media-insert') {
            if (event.target?.type === 'group') {
                const groupId = String(event.target.groupId || '').trim();
                const members = (board?.widgets || []).filter((entry) => String(entry?.groupId || '') === groupId);
                if (!groupId || members.length < 2) throw new Error('The selected Blackboard group no longer exists.');
                return {
                    ok: true,
                    changed: false,
                    clientAction: { type: 'scripta-insert-group', groupId, alt: String(event.payload?.alt || 'Blackboard diagram') }
                };
            }
            const widget = (board?.widgets || []).find((entry) => entry?.id === event.target.widgetId);
            const assetId = String(widget?.properties?.source?.assetId || '').trim();
            if (widget?.type !== 'image' || !assetId) throw new Error('The selected Blackboard element is not a stored image.');
            event.payload = { ...event.payload, assetId };
        }
        return executeRoboCommand(context, {
            roomId: input.roomId,
            boardId: input.boardId,
            text: /^\/robo(?:\s|$)/i.test(String(input.eventInput || ''))
                ? input.eventInput
                : `/robo ${String(input.eventInput || '')}`,
            source: input.commandSource,
            participantId: input.participantId,
            authInfo: input.authInfo,
        }, { intent: buildScriptaIntent(event), reformulate: deps.reformulate });
    }
    if (events.length === 1 && BOARD_ACTIONS.has(events[0].action)) {
        if (typeof deps.applyRoomBlackboardWorkspaceAction !== 'function') throw new Error('Blackboard workspace actions are unavailable.');
        const event = events[0];
        const selectedBoardId = ['board-transfer', 'board-copy'].includes(event.action)
            ? input.boardId
            : String(event.payload?.targetBoardId || input.boardId).trim();
        return deps.applyRoomBlackboardWorkspaceAction(context, {
            roomId: input.roomId,
            action: event.action,
            boardId: selectedBoardId,
            targetBoardId: event.payload?.targetBoardId,
            title: event.payload?.title,
            targetIndex: event.payload?.targetIndex,
            widgetIds: event.payload?.widgetIds,
            placement: event.payload?.placement,
            participantId: input.participantId,
            authInfo: input.authInfo,
        });
    }
    if (typeof deps.applyRoomBlackboardEvents !== 'function') {
        throw new Error('Atomic blackboard event execution is unavailable.');
    }
    return deps.applyRoomBlackboardEvents(context, {
        roomId: input.roomId,
        boardId: input.boardId,
        events,
        participantId: input.participantId,
        authInfo: input.authInfo,
        source: input.source,
    });
}

export async function executeBlackboardEvent(context, args = {}, deps = {}) {
    const roomId = String(args.roomId || '').trim();
    if (!roomId) throw new Error('Missing required roomId.');
    const boardId = String(args.boardId || '').trim();
    if (!boardId) throw new Error('Missing required boardId.');
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
        boardId,
        participantId,
        authInfo: args.authInfo,
    });
    const eventInput = args.event;
    const earlyParsed = source === 'robo' ? null : parseEventInput(eventInput);
    const earlyInterpreted = earlyParsed
        ? normalizeBlackboardEventResult(earlyParsed, { widgetId: args.selectedWidgetId }, { allowInternal: source === 'ui' })
        : null;
    if (source === 'ui' && earlyInterpreted?.events?.length === 1 && earlyInterpreted.events[0].action === 'board-activate') {
        return executeEvents(deps, context, {
            roomId, boardId, participantId, authInfo: args.authInfo, source, commandSource, eventInput,
        }, earlyInterpreted.events, boardResult.blackboard);
    }
    if (args.clarificationResponse !== undefined) {
        throw new Error('Blackboard clarification responses are not supported. Submit a complete new command.');
    }
    const commandId = String(args.commandId || '').trim() || newEventId('command');
    const initialBoardContext = initialAuditBoardContext(boardResult, boardId);
    const appended = await deps.appendMeetingChat(context, {
        meetingId: roomId,
        authorId: participantId,
        authorName: args.authorName || 'Participant',
        message: auditPendingText(source, eventInput),
        kind: 'event',
        metadata: { status: 'pending', commandId, source, ...initialBoardContext },
        dedupeCommandId: commandId,
        authInfo: args.authInfo,
    });
    const audit = appended.message;
    if (appended.deduplicated) {
        return { ok: audit.metadata?.status === 'success', deduplicated: true, auditMessage: audit };
    }

    let interpreted = null;
    let attemptedBoardContext = initialBoardContext;
    try {
        const parsed = earlyParsed;
        interpreted = parsed
            ? normalizeBlackboardEventResult(parsed, { widgetId: args.selectedWidgetId }, { allowInternal: source === 'ui' })
            : await interpret(deps, eventInput, boardResult.blackboard, boardResult.workspace);
        if (interpreted.error) {
            const semanticFailure = new Error(interpreted.error.message);
            semanticFailure.code = interpreted.error.code;
            throw semanticFailure;
        }
        attemptedBoardContext = finalAuditBoardContext(interpreted.events, boardId, boardResult, null);
        const executionSource = parsed ? source : 'robo';
        const result = await executeEvents(deps, context, {
            roomId,
            boardId,
            participantId,
            authInfo: args.authInfo,
            source: executionSource,
            commandSource,
            eventInput,
        }, interpreted.events, boardResult.blackboard);
        const auditBoardContext = finalAuditBoardContext(interpreted.events, boardId, boardResult, result);
        const auditMessage = await updateAudit(deps, context, roomId, args.authInfo, audit, 'success', {
            events: redact(interpreted.events),
            result: summarize(result),
            ...auditBoardContext,
        }, canonicalAuditText(interpreted.events));
        return { ok: result?.ok !== false, events: interpreted.events, ...result, auditMessage };
    } catch (error) {
        const failure = publicError(error);
        const auditMessage = await updateAudit(deps, context, roomId, args.authInfo, audit, 'error', {
            error: failure,
            ...attemptedBoardContext,
        });
        return { ok: false, error: failure, auditMessage };
    }
}
