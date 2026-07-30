import {
    BLACKBOARD_PUBLIC_ACTIONS,
    BLACKBOARD_SEMANTIC_ERROR_CODES,
    BLACKBOARD_SHAPE_KINDS,
} from './event-contract.mjs';

function nullable(schema) {
    return { anyOf: [schema, { type: 'null' }] };
}

function strictObject(properties) {
    return {
        type: 'object',
        properties,
        required: Object.keys(properties),
        additionalProperties: false,
    };
}

const nullableString = nullable({ type: 'string' });
const nullableNumber = nullable({ type: 'number' });
const nullableBoolean = nullable({ type: 'boolean' });

function geometrySchema() {
    return strictObject({
        x: nullableNumber,
        y: nullableNumber,
        width: nullableNumber,
        height: nullableNumber,
        rotation: nullableNumber,
    });
}

function geometryDeltaSchema() {
    return strictObject({ x: nullableNumber, y: nullableNumber });
}

function groupTransformSchema() {
    return strictObject({
        translation: nullable(strictObject({ x: nullableNumber, y: nullableNumber })),
        rotationDelta: nullableNumber,
        resize: nullable(strictObject({
            x: nullableNumber,
            y: nullableNumber,
            width: nullableNumber,
            height: nullableNumber,
        })),
    });
}

function styleSchema() {
    return strictObject({
        fill: nullableString,
        stroke: nullableString,
        strokeWidth: nullableNumber,
        textColor: nullableString,
        fontFamily: nullableString,
        fontSize: nullableNumber,
        fontWeight: nullableString,
        fontStyle: nullableString,
    });
}

function lineSchema() {
    return strictObject({
        x1: nullableNumber,
        y1: nullableNumber,
        x2: nullableNumber,
        y2: nullableNumber,
        angle: nullableNumber,
        markerStart: nullable({ type: 'string', enum: ['', 'arrow'] }),
        markerEnd: nullable({ type: 'string', enum: ['', 'arrow'] }),
    });
}

function endpointSchema() {
    return strictObject({
        widgetId: nullableString,
        groupId: nullableString,
        ref: nullableString,
        anchor: nullable({ type: 'string', enum: ['left', 'right', 'top', 'bottom'] }),
    });
}

function connectionSchema() {
    return strictObject({ from: nullable(endpointSchema()), to: nullable(endpointSchema()) });
}

function pollQuestionSchema() {
    return strictObject({
        id: nullableString,
        prompt: nullableString,
        pollMode: nullable({ type: 'string', enum: ['choice', 'rating'] }),
        options: nullable({ type: 'array', items: { type: 'string' } }),
        ratingMax: nullableNumber,
    });
}

function bulletItemSchema() {
    return strictObject({
        text: nullableString,
        status: nullable({ type: 'string', enum: ['todo', 'inProgress', 'done', 'blocked'] }),
        priority: nullable({ type: 'string', enum: ['high', 'medium', 'low'] }),
    });
}

function paragraphSchema() {
    return strictObject({ text: nullableString });
}

function chapterSchema() {
    return strictObject({
        title: nullableString,
        paragraphs: nullable({ type: 'array', items: paragraphSchema() }),
    });
}

function widgetPropertiesSchema() {
    return strictObject({
        geometry: nullable(geometrySchema()),
        geometryDelta: nullable(geometryDeltaSchema()),
        style: nullable(styleSchema()),
        rotation: nullableNumber,
        label: nullableString,
        shapeKind: nullable({ type: 'string', enum: BLACKBOARD_SHAPE_KINDS }),
        line: nullable(lineSchema()),
        connection: nullable(connectionSchema()),
        text: nullableString,
        alt: nullableString,
        title: nullableString,
        description: nullableString,
        questions: nullable({ type: 'array', items: pollQuestionSchema() }),
        allowPollChange: nullableBoolean,
        anonymous: nullableBoolean,
        durationSeconds: nullableNumber,
        resultsVisibility: nullableString,
        items: nullable({ type: 'array', items: bulletItemSchema() }),
    });
}

function pollAnswerSchema() {
    return strictObject({ questionId: { type: 'string' }, answer: { type: 'string' } });
}

function eventPayloadSchema() {
    return strictObject({
        widget: nullable(strictObject({
            type: { type: 'string', enum: ['shape', 'line', 'text', 'image', 'card', 'poll', 'bullets', 'embed'] },
            properties: widgetPropertiesSchema(),
        })),
        patch: nullable(strictObject({
            properties: nullable(widgetPropertiesSchema()),
            transform: nullable(groupTransformSchema()),
        })),
        widgetIds: nullable({ type: 'array', items: { type: 'string' } }),
        reason: nullableString,
        data: nullable(strictObject({
            answers: nullable({ type: 'array', items: pollAnswerSchema() }),
            participantName: nullableString,
        })),
        confirmed: nullableBoolean,
        resourceId: nullableString,
        name: nullableString,
        path: nullableString,
        folderPath: nullableString,
        template: nullableString,
        objective: nullableString,
        visionParagraphs: nullable({ type: 'array', items: paragraphSchema() }),
        planParagraphs: nullable({ type: 'array', items: paragraphSchema() }),
        chapters: nullable({ type: 'array', items: chapterSchema() }),
        chapterId: nullableString,
        chapterOrdinal: nullableNumber,
        paragraphId: nullableString,
        paragraphOrdinal: nullableNumber,
        targetChapterId: nullableString,
        targetChapterOrdinal: nullableNumber,
        targetIndex: nullableNumber,
        targetBoardId: nullableString,
        placement: nullable(strictObject({ x: nullableNumber, y: nullableNumber })),
        variantId: nullableString,
        variantOrdinal: nullableNumber,
        imageId: nullableString,
        imageOrdinal: nullableNumber,
        assetId: nullableString,
        alt: nullableString,
        position: nullableNumber,
        widthPercent: nullableNumber,
        aspectRatio: nullableString,
        fit: nullableString,
        alignment: nullableString,
        type: nullableString,
        title: nullableString,
        text: nullableString,
        mode: nullableString,
        direction: nullableString,
        editing: nullableBoolean,
    });
}

function eventSchema() {
    return strictObject({
        ref: nullableString,
        action: { type: 'string', enum: BLACKBOARD_PUBLIC_ACTIONS },
        target: strictObject({
            type: { type: 'string', enum: ['workspace', 'blackboard', 'widget', 'group'] },
            widgetId: nullableString,
            ref: nullableString,
            groupId: nullableString,
        }),
        payload: eventPayloadSchema(),
    });
}

export function getBlackboardStructuredResultSchema() {
    const events = { type: 'array', minItems: 1, items: eventSchema() };
    const error = strictObject({
        code: { type: 'string', enum: BLACKBOARD_SEMANTIC_ERROR_CODES },
        message: { type: 'string' },
    });
    return {
        ...strictObject({
            events: nullable(events),
            error: nullable(error),
        }),
        anyOf: [
            { properties: { events, error: { type: 'null' } } },
            { properties: { events: { type: 'null' }, error } },
        ],
    };
}

export function getBlackboardChatResponseFormat() {
    return {
        type: 'json_schema',
        json_schema: {
            name: 'webmeet_blackboard_result',
            strict: true,
            schema: getBlackboardStructuredResultSchema(),
        },
    };
}

function removeNullFields(value) {
    if (Array.isArray(value)) return value.map(removeNullFields);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
        entry === null ? [] : [[key, removeNullFields(entry)]]
    )));
}

export function normalizeBlackboardStructuredResult(value) {
    const normalized = removeNullFields(value);
    const hasEvents = Array.isArray(normalized?.events) && normalized.events.length > 0;
    const hasError = Boolean(normalized?.error) && typeof normalized.error === 'object' && !Array.isArray(normalized.error);
    if (hasEvents === hasError) {
        throw new Error('Interpreter result must contain exactly one non-empty terminal branch: events or error.');
    }
    for (const event of normalized?.events || []) {
        const answers = event?.payload?.data?.answers;
        if (Array.isArray(answers)) {
            event.payload.data.answers = Object.fromEntries(answers.map((entry) => [
                String(entry?.questionId || '').trim(),
                String(entry?.answer || '').trim(),
            ]).filter(([questionId]) => questionId));
        }
    }
    return normalized;
}
