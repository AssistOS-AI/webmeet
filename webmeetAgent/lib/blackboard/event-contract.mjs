import crypto from 'node:crypto';

export const BLACKBOARD_EVENT_ACTIONS = Object.freeze(new Set([
    'update', 'clear', 'undo', 'redo', 'show', 'hide',
    'create', 'delete', 'submit', 'start', 'close', 'reorder', 'lock', 'unlock',
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
]));

function requiredString(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`Missing required event ${label}.`);
    return normalized;
}

export function newEventId(prefix = 'event') {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function parseEventInput(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
    const source = String(input || '').trim();
    if (source.startsWith('{')) {
        try {
            const parsed = JSON.parse(source);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
        } catch {
            throw new Error('The /event payload must be valid JSON.');
        }
    }
    const semantic = source.match(/^([a-z][a-z0-9-]*)(?:\s+([\s\S]+))?$/i);
    const action = String(semantic?.[1] || '').toLowerCase();
    if (!BLACKBOARD_EVENT_ACTIONS.has(action)) return null;
    const payloadSource = String(semantic?.[2] || '').trim();
    if (!payloadSource) return { action, payload: {} };
    try {
        const payload = JSON.parse(payloadSource);
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('not an object');
        }
        return { action, payload };
    } catch {
        throw new Error(`The /event ${action} payload must be a valid JSON object.`);
    }
}

export function normalizeBlackboardEvent(input, defaults = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('A blackboard event object is required.');
    }
    const targetType = requiredString(input.target?.type || defaults.targetType || 'blackboard', 'target.type');
    if (!['blackboard', 'widget'].includes(targetType)) {
        throw new Error('Event target.type must be "blackboard" or "widget".');
    }
    const action = requiredString(input.action, 'action');
    if (!BLACKBOARD_EVENT_ACTIONS.has(action)) {
        throw new Error(`Unsupported blackboard event action "${action}".`);
    }
    const expectedBoardVersion = input.expectedBoardVersion ?? defaults.expectedBoardVersion;
    if (expectedBoardVersion === undefined || expectedBoardVersion === null || expectedBoardVersion === '') {
        throw new Error('Missing required event expectedBoardVersion.');
    }
    const normalizedVersion = Number(expectedBoardVersion);
    if (!Number.isInteger(normalizedVersion) || normalizedVersion < 0) {
        throw new Error('event.expectedBoardVersion must be a non-negative integer.');
    }
    const target = {
        type: targetType,
        boardId: requiredString(input.target?.boardId || defaults.boardId, 'target.boardId')
    };
    const widgetId = String(input.target?.widgetId || defaults.widgetId || '').trim();
    if (targetType === 'widget' && !widgetId && action !== 'create') {
        throw new Error('Missing required event target.widgetId.');
    }
    if (widgetId) target.widgetId = widgetId;
    return {
        eventId: requiredString(input.eventId || defaults.eventId || newEventId(), 'eventId'),
        commandId: requiredString(input.commandId || defaults.commandId || newEventId('command'), 'commandId'),
        expectedBoardVersion: normalizedVersion,
        target,
        action,
        payload: input.payload && typeof input.payload === 'object' && !Array.isArray(input.payload)
            ? structuredClone(input.payload)
            : {}
    };
}
