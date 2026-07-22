import crypto from 'node:crypto';

export const BLACKBOARD_PUBLIC_ACTIONS = Object.freeze([
    'create', 'update', 'delete', 'group', 'ungroup', 'clear', 'undo', 'redo', 'show', 'hide',
    'submit', 'start', 'close', 'reorder',
    'scripta-document-create', 'scripta-document-open', 'scripta-document-delete',
    'scripta-paragraph-open', 'scripta-document-view', 'scripta-paragraph-next', 'scripta-paragraph-previous',
    'scripta-p-variant-add', 'scripta-p-variant-select',
    'scripta-p-variant-edit-start', 'scripta-p-variant-edit-cancel',
    'scripta-p-variant-edit', 'scripta-p-variant-delete',
    'scripta-p-variant-vote', 'scripta-p-variant-vote-withdraw', 'scripta-p-variant-reformulate',
    'scripta-undo', 'scripta-chapter-add', 'scripta-chapter-edit', 'scripta-chapter-delete',
    'scripta-chapter-move', 'scripta-paragraph-add', 'scripta-paragraph-delete', 'scripta-paragraph-move',
]);

export const BLACKBOARD_INTERNAL_ACTIONS = Object.freeze(['focus']);
export const BLACKBOARD_SEMANTIC_ERROR_CODES = Object.freeze([
    'ambiguous_target',
    'missing_target',
    'target_type_mismatch',
    'ambiguous_operation',
    'confirmation_required',
    'unsupported_request',
]);
export const BLACKBOARD_EVENT_ACTIONS = Object.freeze(new Set(BLACKBOARD_PUBLIC_ACTIONS));
export const BLACKBOARD_CONNECTION_ANCHORS = Object.freeze(new Set(['left', 'right', 'top', 'bottom', 'center']));
export const BLACKBOARD_CREATABLE_WIDGET_TYPES = Object.freeze(new Set([
    'shape', 'line', 'text', 'image', 'card', 'poll', 'bullets', 'embed',
]));

export const BLACKBOARD_SHAPE_KINDS = Object.freeze(['rectangle', 'rounded', 'ellipse', 'diamond', 'triangle']);

const SCRIPTA_TARGET_FIELDS = ['resourceId', 'chapterId', 'chapterOrdinal', 'paragraphId', 'paragraphOrdinal'];
export const BLACKBOARD_SCRIPTA_ACTION_PAYLOAD_FIELDS = Object.freeze({
    'scripta-document-create': Object.freeze(['mode', 'name', 'title', 'path', 'folderPath', 'template', 'objective', 'visionParagraphs', 'planParagraphs', 'chapters']),
    'scripta-document-open': Object.freeze(['path']),
    'scripta-document-delete': Object.freeze(['resourceId', 'confirmed']),
    'scripta-paragraph-open': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal', 'mode', 'editing']),
    'scripta-document-view': Object.freeze(['resourceId', 'mode']),
    'scripta-paragraph-next': Object.freeze(['resourceId']),
    'scripta-paragraph-previous': Object.freeze(['resourceId']),
    'scripta-p-variant-add': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'text']),
    'scripta-p-variant-select': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal']),
    'scripta-p-variant-edit-start': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal']),
    'scripta-p-variant-edit-cancel': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal']),
    'scripta-p-variant-edit': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal', 'text']),
    'scripta-p-variant-delete': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal']),
    'scripta-p-variant-vote': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal', 'type']),
    'scripta-p-variant-vote-withdraw': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'variantId', 'variantOrdinal', 'type']),
    'scripta-p-variant-reformulate': Object.freeze([...SCRIPTA_TARGET_FIELDS]),
    'scripta-undo': Object.freeze(['resourceId']),
    'scripta-chapter-add': Object.freeze(['resourceId', 'title']),
    'scripta-chapter-edit': Object.freeze(['resourceId', 'chapterId', 'chapterOrdinal', 'title']),
    'scripta-chapter-delete': Object.freeze(['resourceId', 'chapterId', 'chapterOrdinal']),
    'scripta-chapter-move': Object.freeze(['resourceId', 'chapterId', 'chapterOrdinal', 'targetIndex']),
    'scripta-paragraph-add': Object.freeze(['resourceId', 'chapterId', 'chapterOrdinal', 'text']),
    'scripta-paragraph-delete': Object.freeze([...SCRIPTA_TARGET_FIELDS]),
    'scripta-paragraph-move': Object.freeze([...SCRIPTA_TARGET_FIELDS, 'targetChapterOrdinal', 'targetIndex']),
});

export function getBlackboardScriptaEventSchemaPrompt() {
    return Object.entries(BLACKBOARD_SCRIPTA_ACTION_PAYLOAD_FIELDS).map(([action, fields]) => (
        `${action}: payload={${fields.join(',')}}`
    )).join('\n');
}

const COMMON_CREATE_PROPERTIES = ['geometry', 'style'];
export const BLACKBOARD_WIDGET_EVENT_SCHEMAS = Object.freeze({
    shape: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'label', 'shapeKind']),
        variants: BLACKBOARD_SHAPE_KINDS,
        semantics: 'rectangle/box -> rectangle; rounded rectangle -> rounded; circle -> ellipse with equal width and height; oval/ellipse -> ellipse; diamond/rhombus -> diamond; triangle -> triangle',
    }),
    line: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'line', 'connection']),
        semantics: 'free line -> line:{x1,y1,x2,y2,markerStart?,markerEnd?}; arrow -> markerEnd:"arrow"; double arrow -> markerStart:"arrow", markerEnd:"arrow"; attached connector -> connection:{from,to}',
    }),
    text: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'text']),
        semantics: 'independent text box; use text for its content',
    }),
    image: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'alt']),
        semantics: 'image placeholder only; never invent source URLs, downloads, or paths',
    }),
    card: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'title', 'text']),
        semantics: 'standalone card/note with optional title and text',
    }),
    poll: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'description', 'questions', 'allowPollChange', 'anonymous', 'durationSeconds', 'resultsVisibility']),
        semantics: 'poll widget; questions contain id, prompt, pollMode, options, and ratingMax',
    }),
    bullets: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'title', 'items', 'resultsVisibility']),
        semantics: 'meeting bullets; items contain text, status todo|inProgress|done|blocked, and priority high|medium|low',
    }),
    embed: Object.freeze({
        createProperties: Object.freeze([...COMMON_CREATE_PROPERTIES, 'title']),
        semantics: 'generic embedded placeholder with a title; never invent private URLs or paths',
    }),
});

const COMMON_EDITABLE_PROPERTIES = ['geometry', 'geometryDelta', 'style', 'rotation'];
const SCRIPTA_DOMAIN_ACTIONS = BLACKBOARD_PUBLIC_ACTIONS.filter((action) => action.startsWith('scripta-'));
export const BLACKBOARD_WIDGET_CAPABILITIES = Object.freeze({
    shape: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'label', 'shapeKind'], domainActions: [] },
    text: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'text'], domainActions: [] },
    line: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'line', 'connection'], domainActions: [] },
    image: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'alt'], domainActions: [] },
    card: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'title', 'text'], domainActions: [] },
    embed: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'title'], domainActions: [] },
    poll: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'description', 'resultsVisibility', 'questions', 'allowPollChange', 'anonymous', 'durationSeconds'], domainActions: ['submit', 'start', 'close'] },
    bullets: { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES, 'title', 'items', 'resultsVisibility'], domainActions: ['reorder'] },
    'scripta-document': { movable: true, resizable: true, deletable: true, editableProperties: [...COMMON_EDITABLE_PROPERTIES], domainActions: [...SCRIPTA_DOMAIN_ACTIONS] },
});

const FORBIDDEN_AUTHORITY_KEYS = new Set([
    'createdBy', 'updatedBy', 'requestedBy', 'executor', 'participantId',
    'eventId', 'commandId', 'revision', 'version', 'expectedBoardVersion',
]);

function requiredString(value, label) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`Missing required event ${label}.`);
    return normalized;
}

function plainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${label} must be an object.`);
    }
    return value;
}

function assertOnlyKeys(value, allowedKeys, label) {
    const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
    if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.join(', ')}.`);
}

function finiteNumber(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} must be a finite number.`);
    return number;
}

function validateGeometry(value, label) {
    const geometry = plainObject(value, label);
    assertOnlyKeys(geometry, ['x', 'y', 'width', 'height', 'rotation'], label);
    for (const key of Object.keys(geometry)) geometry[key] = finiteNumber(geometry[key], `${label}.${key}`);
    if (geometry.width !== undefined && geometry.width <= 0) throw new Error(`${label}.width must be greater than zero.`);
    if (geometry.height !== undefined && geometry.height <= 0) throw new Error(`${label}.height must be greater than zero.`);
}

function validateGeometryDelta(value, label) {
    const delta = plainObject(value, label);
    assertOnlyKeys(delta, ['x', 'y'], label);
    if (delta.x === undefined && delta.y === undefined) throw new Error(`${label} requires x or y.`);
    const x = delta.x === undefined ? 0 : finiteNumber(delta.x, `${label}.x`);
    const y = delta.y === undefined ? 0 : finiteNumber(delta.y, `${label}.y`);
    if (x === 0 && y === 0) throw new Error(`${label} must move at least one axis.`);
    delta.x = x;
    delta.y = y;
}

function validateStyle(value, label) {
    const style = plainObject(value, label);
    assertOnlyKeys(style, ['fill', 'stroke', 'strokeWidth', 'textColor', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle'], label);
    for (const key of ['strokeWidth', 'fontSize']) {
        if (style[key] !== undefined) style[key] = finiteNumber(style[key], `${label}.${key}`);
    }
}

function validateLine(value, label, { requireCoordinates = false } = {}) {
    const line = plainObject(value, label);
    assertOnlyKeys(line, ['x1', 'y1', 'x2', 'y2', 'angle', 'markerStart', 'markerEnd'], label);
    const coordinateKeys = ['x1', 'y1', 'x2', 'y2'];
    if (requireCoordinates && coordinateKeys.some((key) => line[key] === undefined)) {
        throw new Error(`${label} requires x1, y1, x2, and y2.`);
    }
    for (const key of [...coordinateKeys, 'angle']) {
        if (line[key] !== undefined) line[key] = finiteNumber(line[key], `${label}.${key}`);
    }
    for (const key of ['markerStart', 'markerEnd']) {
        if (line[key] !== undefined && !['', 'arrow'].includes(String(line[key]))) {
            throw new Error(`${label}.${key} must be empty or "arrow".`);
        }
    }
}

function validateStructuredWidgetProperties(widgetType, properties, { creating = false } = {}) {
    const label = creating ? 'event.payload.widget.properties' : 'event.payload.patch.properties';
    if (properties.geometry !== undefined) validateGeometry(properties.geometry, `${label}.geometry`);
    if (properties.geometryDelta !== undefined) {
        if (creating) throw new Error(`${label}.geometryDelta is update-only.`);
        validateGeometryDelta(properties.geometryDelta, `${label}.geometryDelta`);
    }
    if (properties.style !== undefined) validateStyle(properties.style, `${label}.style`);
    if (properties.rotation !== undefined) properties.rotation = finiteNumber(properties.rotation, `${label}.rotation`);
    if (properties.line !== undefined) validateLine(properties.line, `${label}.line`, {
        requireCoordinates: creating && widgetType === 'line' && properties.connection === undefined,
    });
}

function assertNoAuthorityFields(value, path = 'event') {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertNoAuthorityFields(entry, `${path}[${index}]`));
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_AUTHORITY_KEYS.has(key)) {
            throw new Error(`${path}.${key} is server-controlled.`);
        }
        if (key === 'provenance') throw new Error(`${path}.provenance is server-controlled.`);
        assertNoAuthorityFields(entry, `${path}.${key}`);
    }
}

function validateScriptaPayload(action, target, payload) {
    if (target.type !== 'widget') throw new Error(`${action} must target a widget.`);
    const allowedFields = BLACKBOARD_SCRIPTA_ACTION_PAYLOAD_FIELDS[action];
    if (!allowedFields) throw new Error(`Missing canonical payload schema for ${action}.`);
    assertOnlyKeys(payload, allowedFields, `event.payload for ${action}`);

    for (const key of ['chapterOrdinal', 'paragraphOrdinal', 'targetChapterOrdinal', 'variantOrdinal']) {
        if (payload[key] === undefined) continue;
        const value = finiteNumber(payload[key], `event.payload.${key}`);
        if (!Number.isInteger(value) || value < 1) throw new Error(`event.payload.${key} must be a positive integer.`);
        payload[key] = value;
    }
    if (payload.targetIndex !== undefined) {
        const value = finiteNumber(payload.targetIndex, 'event.payload.targetIndex');
        if (!Number.isInteger(value) || value < 0) throw new Error('event.payload.targetIndex must be a non-negative integer.');
        payload.targetIndex = value;
    }
    for (const key of ['confirmed', 'editing']) {
        if (payload[key] !== undefined && typeof payload[key] !== 'boolean') {
            throw new Error(`event.payload.${key} must be a boolean.`);
        }
    }
    if (payload.type !== undefined && !['like', 'dislike'].includes(String(payload.type))) {
        throw new Error('event.payload.type must be "like" or "dislike".');
    }

    if (action === 'scripta-document-create' && !String(payload.name || payload.title || '').trim()) {
        throw new Error('scripta-document-create requires a non-empty name or title.');
    }
    if (action === 'scripta-document-open' && !String(payload.path || '').trim()) {
        throw new Error('scripta-document-open requires a non-empty path.');
    }
    if (action === 'scripta-chapter-edit') {
        payload.title = String(payload.title || '').replace(/\s+/g, ' ').trim();
        if (!payload.title) throw new Error('scripta-chapter-edit requires a non-empty title.');
    }
}

function normalizeEndpoint(endpoint, label) {
    plainObject(endpoint, label);
    const widgetId = String(endpoint.widgetId || '').trim();
    const ref = String(endpoint.ref || '').trim();
    if (Boolean(widgetId) === Boolean(ref)) {
        throw new Error(`${label} must contain exactly one of widgetId or ref.`);
    }
    const anchor = String(endpoint.anchor || 'center').trim();
    if (!BLACKBOARD_CONNECTION_ANCHORS.has(anchor)) {
        throw new Error(`${label}.anchor is invalid.`);
    }
    return { ...(widgetId ? { widgetId } : { ref }), anchor };
}

function normalizeConnection(properties = {}, label = 'properties.connection') {
    if (properties.connection === undefined) return properties;
    const connection = plainObject(properties.connection, label);
    return {
        ...properties,
        connection: {
            from: normalizeEndpoint(connection.from, `${label}.from`),
            to: normalizeEndpoint(connection.to, `${label}.to`),
        },
    };
}

export function getCanonicalWidgetCapabilities(type = '') {
    const capabilities = BLACKBOARD_WIDGET_CAPABILITIES[String(type || '').trim()];
    return capabilities ? structuredClone(capabilities) : null;
}

export function getBlackboardWidgetEventSchemaPrompt() {
    return Object.entries(BLACKBOARD_WIDGET_EVENT_SCHEMAS).map(([type, schema]) => {
        const variants = schema.variants ? `; variants=${schema.variants.join('|')}` : '';
        return `- ${type}: properties=${schema.createProperties.join('|')}${variants}; ${schema.semantics}`;
    }).join('\n');
}

function validateCreateWidgetProperties(widgetType, properties) {
    const schema = BLACKBOARD_WIDGET_EVENT_SCHEMAS[widgetType];
    if (!schema) throw new Error(`Unsupported blackboard widget type "${widgetType}".`);
    const forbidden = Object.keys(properties).filter((key) => !schema.createProperties.includes(key));
    if (forbidden.length) throw new Error(`Widget type "${widgetType}" cannot create properties: ${forbidden.join(', ')}.`);
    if (widgetType === 'shape' && properties.shapeKind !== undefined) {
        const shapeKind = String(properties.shapeKind || '').trim();
        if (!BLACKBOARD_SHAPE_KINDS.includes(shapeKind)) {
            throw new Error(`Invalid shapeKind "${shapeKind}". Expected one of: ${BLACKBOARD_SHAPE_KINDS.join(', ')}.`);
        }
        properties.shapeKind = shapeKind;
    }
    if (widgetType === 'line' && properties.connection === undefined && properties.line === undefined) {
        throw new Error('A free line requires properties.line.');
    }
    validateStructuredWidgetProperties(widgetType, properties, { creating: true });
}

export function assertCanonicalWidgetPatch(widget = {}, patch = {}) {
    plainObject(patch, 'event.payload.patch');
    const unexpectedPatchKeys = Object.keys(patch).filter((key) => key !== 'properties');
    if (unexpectedPatchKeys.length) throw new Error(`Widget update cannot modify ${unexpectedPatchKeys.join(', ')}.`);
    const properties = plainObject(patch.properties || {}, 'event.payload.patch.properties');
    const capabilities = getCanonicalWidgetCapabilities(widget.type);
    if (!capabilities) throw new Error(`Unsupported blackboard widget type "${String(widget.type || '')}".`);
    const allowed = new Set(capabilities.editableProperties);
    const forbidden = Object.keys(properties).filter((key) => !allowed.has(key));
    if (forbidden.length) throw new Error(`Widget type "${widget.type}" cannot update properties: ${forbidden.join(', ')}.`);
    normalizeConnection(properties, 'event.payload.patch.properties.connection');
    validateStructuredWidgetProperties(widget.type, properties);
    return true;
}

export function newEventId(prefix = 'event') {
    return `${prefix}_${crypto.randomUUID()}`;
}

export function parseEventInput(input) {
    if (input && typeof input === 'object' && !Array.isArray(input)) return structuredClone(input);
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
        plainObject(payload, `The /event ${action} payload`);
        return { action, payload };
    } catch (error) {
        if (String(error?.message || '').includes('must be an object')) throw error;
        throw new Error(`The /event ${action} payload must be a valid JSON object.`);
    }
}

function normalizeTarget(input, action, defaults = {}) {
    if (input?.boardId !== undefined) throw new Error('event.target.boardId is not part of the canonical event contract.');
    const targetType = requiredString(input?.type || defaults.targetType || (
        ['create', 'group', 'clear', 'undo', 'redo', 'show', 'hide'].includes(action) ? 'blackboard' : 'widget'
    ), 'target.type');
    if (!['blackboard', 'widget'].includes(targetType)) {
        throw new Error('Event target.type must be "blackboard" or "widget".');
    }
    const widgetId = String(input?.widgetId || defaults.widgetId || (action.startsWith('scripta-') ? 'robo_scripta_document' : '')).trim();
    const ref = String(input?.ref || '').trim();
    if (targetType === 'widget' && !widgetId && !ref) {
        throw new Error('Missing required event target.widgetId or target.ref.');
    }
    if (widgetId && ref) throw new Error('Event target cannot contain both widgetId and ref.');
    return { type: targetType, ...(widgetId ? { widgetId } : {}), ...(ref ? { ref } : {}) };
}

function validateActionShape(event) {
    const { action, target, payload } = event;
    if (action === 'create') {
        if (target.type !== 'blackboard') throw new Error('create must target the blackboard.');
        const widget = plainObject(payload.widget, 'event.payload.widget');
        const widgetType = requiredString(widget.type, 'payload.widget.type');
        if (!BLACKBOARD_CREATABLE_WIDGET_TYPES.has(widgetType)) throw new Error(`Widget type "${widgetType}" must be created through its specialized action.`);
        if (widget.id !== undefined) throw new Error('Widget ids are generated by the server.');
        const unexpectedWidgetKeys = Object.keys(widget).filter((key) => !['type', 'properties'].includes(key));
        if (unexpectedWidgetKeys.length) throw new Error(`Create widget cannot set ${unexpectedWidgetKeys.join(', ')}.`);
        widget.properties = normalizeConnection(plainObject(widget.properties || {}, 'event.payload.widget.properties'));
        validateCreateWidgetProperties(widgetType, widget.properties);
    } else if (action === 'update') {
        const patch = plainObject(payload.patch, 'event.payload.patch');
        if (target.type === 'widget') {
            const unexpectedPatchKeys = Object.keys(patch).filter((key) => key !== 'properties');
            if (unexpectedPatchKeys.length) throw new Error(`Widget update cannot modify ${unexpectedPatchKeys.join(', ')}.`);
        }
        if (patch.properties !== undefined) {
            patch.properties = normalizeConnection(plainObject(patch.properties, 'event.payload.patch.properties'));
        }
    } else if (action === 'delete' || action === 'ungroup' || action === 'focus') {
        if (target.type !== 'widget') throw new Error(`${action} must target a widget.`);
    } else if (action === 'group') {
        if (target.type !== 'blackboard') throw new Error('group must target the blackboard.');
        const ids = Array.isArray(payload.widgetIds) ? payload.widgetIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
        if (ids.length < 2 || new Set(ids).size !== ids.length) {
            throw new Error('group requires at least two distinct widgetIds.');
        }
        payload.widgetIds = ids;
    } else if (action.startsWith('scripta-')) {
        validateScriptaPayload(action, target, payload);
    }
}

export function normalizeBlackboardEvent(input, defaults = {}, options = {}) {
    plainObject(input, 'A blackboard event');
    assertNoAuthorityFields(input);
    const action = requiredString(input.action, 'action');
    const allowed = options.allowInternal === true
        ? new Set([...BLACKBOARD_PUBLIC_ACTIONS, ...BLACKBOARD_INTERNAL_ACTIONS])
        : BLACKBOARD_EVENT_ACTIONS;
    if (!allowed.has(action)) throw new Error(`Unsupported blackboard event action "${action}".`);
    const event = {
        ...(input.ref !== undefined ? { ref: requiredString(input.ref, 'ref') } : {}),
        action,
        target: normalizeTarget(input.target, action, defaults),
        payload: input.payload === undefined ? {} : structuredClone(plainObject(input.payload, 'event.payload')),
    };
    validateActionShape(event);
    return event;
}

export function normalizeBlackboardEventResult(input, defaults = {}, options = {}) {
    plainObject(input, 'Interpreter result');
    if (input.clarificationRequired !== undefined || input.question !== undefined || input.options !== undefined) {
        throw new Error('Interpreter clarification results are not supported. Return a natural-language error instead.');
    }
    if (input.error !== undefined) {
        plainObject(input.error, 'Interpreter error');
        if (input.events !== undefined || input.action !== undefined) {
            throw new Error('Interpreter result cannot contain both an error and executable events.');
        }
        const code = requiredString(input.error.code, 'error.code');
        if (!BLACKBOARD_SEMANTIC_ERROR_CODES.includes(code)) {
            throw new Error(`Unsupported interpreter error code "${code}".`);
        }
        return {
            error: {
                code,
                message: requiredString(input.error.message, 'error.message').slice(0, 500),
            },
        };
    }
    const events = Array.isArray(input.events) ? input.events : [input];
    if (!events.length) throw new Error('Interpreter returned no blackboard events.');
    return { events: events.map((event) => normalizeBlackboardEvent(event, defaults, options)) };
}
