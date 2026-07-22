import {
    BLACKBOARD_PUBLIC_ACTIONS,
    getBlackboardWidgetEventSchemaPrompt,
    normalizeBlackboardEventResult,
} from '../../../lib/blackboard/event-contract.mjs';

function responseValue(response) {
    const value = response?.result ?? response?.content ?? response;
    return typeof value === 'string' ? JSON.parse(value) : value;
}

async function requestCanonicalResult(llmAgent, prompt) {
    return normalizeBlackboardEventResult(responseValue(
        await llmAgent.executePrompt(prompt, { responseShape: 'json', model: 'plan' })
    ));
}

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt) throw new Error('Blackboard event interpretation requires an LLM agent.');
    const prompt = [
        'Convert the participant instruction into {events:[...]} containing one or more canonical WebMeet blackboard events.',
        'Understand the instruction semantically in any language; never match a hardcoded phrase list.',
        'If the instruction cannot be resolved deterministically, return exactly {error:{code:string,message:string}} and no events. Never ask a clarification question. Explain the exact cause naturally in the same language as the instruction. Use one of: ambiguous_target, missing_target, target_type_mismatch, ambiguous_operation, confirmation_required, unsupported_request.',
        `Allowed actions: ${BLACKBOARD_PUBLIC_ACTIONS.join(', ')}.`,
        'Never output add, lock, unlock, or focus. Never output ids for newly created widgets, provenance, participant ids, revisions, command ids, or event ids.',
        'create targets {type:"blackboard"} and uses payload.widget:{type,properties}. update targets an existing widgetId or prior local ref and uses payload.patch.',
        'Use a unique event.ref on create when a later event in the same command needs that widget. References are ordered and cannot point forward.',
        'Every existing widget has a transient global ordinal. An explicit ordinal reference such as "line 3" targets board.widgets ordinal 3 and must also match the named widget kind. An ordinal reference outranks labels, focus, and lastAffectedWidgetIds. A kind mismatch returns target_type_mismatch.',
        'Connections are line widgets with properties.connection.from/to; each endpoint has widgetId or ref and anchor left, right, top, bottom, or center.',
        'Use properties.label for text centered inside a shape. Use a text widget only for independent text.',
        'Canonical widget creation schemas (these are exhaustive; semantic names such as circle are not widget types):',
        getBlackboardWidgetEventSchemaPrompt(),
        'The empty-board logical frame is 1200 by 800. Center against board.contentBounds. Default generated-layout gap is 40 px.',
        'For "right of" a widget, place the new left edge at the target right bound plus the requested gap or 40 px, and align vertical centers. For a free line, its bounds are the min/max of line endpoints.',
        'A circle is shapeKind:"ellipse" with equal width and height; when no diameter is given use 100 by 100. An oval may use unequal width and height.',
        'For relative movement use exactly patch.properties.geometryDelta:{x,y}; never use dx/dy. Down is positive y, up is negative y, right is positive x, and left is negative x. A direction without distance uses 40 px. "larger" without a value means 20 percent.',
        'A free line MUST use payload.widget.properties.line:{x1,y1,x2,y2,markerStart?,markerEnd?}. These create coordinates are absolute blackboard coordinates. Never put x1, y1, x2, or y2 in properties.geometry.',
        'For a free line defined by center, length, and angle, calculate both endpoints deterministically with cosine and sine.',
        'When creating or adding a free line while board.focusedWidgetId identifies a free line, and the participant gives no different origin or center, continue from that focused line: use its absolute line.x2/y2 as the new x1/y1 and extend x2/y2 by cos(angle)*length and sin(angle)*length. An explicit origin, center, target, or instruction not to connect takes priority.',
        'For SCRIPTA actions, payload.intent is required and must use one of these exact schemas:',
        '- document: {kind:"document", operation, resourceId, name, path, folderPath, template, objective, visionParagraphs, planParagraphs, chapters}.',
        '- Vision, Plan, and General are creation templates. Vision requires at least three generated aspect paragraphs; Plan requires generated chapters; General creates one empty chapter and paragraph.',
        '- focus: {kind:"focus", resourceId, chapterId or chapterOrdinal, paragraphId or paragraphOrdinal, variantId when selecting a variant, mode:"paragraph"|"document"}.',
        '- navigation: {kind:"navigation", direction:"next"|"previous"}.',
        '- reformulate: {kind:"ai-reformulate"}.',
        '- mutation: {kind:"mutation", operation, resourceId, chapterOrdinal, paragraphOrdinal, targetChapterOrdinal, variantId, variantOrdinal, type, title, text}; include only fields needed by the operation.',
        'SCRIPTA mutation operations are p-variant-add, p-variant-vote, p-variant-vote-withdraw, p-variant-edit, p-variant-delete, chapter-add, chapter-delete, chapter-rename, chapter-move, paragraph-add, paragraph-delete, paragraph-move, and undo.',
        'Only the participant who added a paragraph variant may edit or delete it. All admitted participants may vote on any variant.',
        'Document operations are document-create, document-open, and document-delete.',
        'Physical document deletion must include confirmed:true only when the participant explicitly confirms deletion; otherwise return error code confirmation_required.',
        'For relative navigation use navigation intent; do not calculate IDs yourself.',
        'For generic widget changes use only the canonical payload schemas; never emit payload.change.',
        'Resolve targets in this order: explicit ordinal, other explicit mention, board.focusedWidgetId, then board.lastAffectedWidgetIds for plural wording. A named widget kind is an explicit constraint: a request naming a line may target only a line, a shape only a shape, and so on. Never use a focused widget whose type conflicts with the explicit kind. If multiple compatible widgets remain and the instruction does not distinguish one, return ambiguous_target with a precise natural-language cause.',
        'Use only IDs present in context. Never invent path values.',
        'If a target or operation is genuinely ambiguous, return an error with a concise natural-language cause and do not emit events.',
        `Instruction: ${String(promptText || '')}`,
        `Context: ${JSON.stringify(context || {})}`
    ].join('\n');
    const response = await llmAgent.executePrompt(prompt, { responseShape: 'json', model: 'plan' });
    const result = responseValue(response);
    let canonical;
    try {
        canonical = normalizeBlackboardEventResult(result);
    } catch (error) {
        const correctionPrompt = [
            prompt,
            `Your previous result was rejected by the canonical validator: ${String(error?.message || error)}`,
            `Previous result: ${JSON.stringify(result)}`,
            'Re-evaluate all targets as well as the invalid fields. Return a corrected canonical result only. Do not explain the correction.',
        ].join('\n');
        canonical = await requestCanonicalResult(llmAgent, correctionPrompt);
    }
    if (canonical.error) return canonical;
    const verificationPrompt = [
        prompt,
        `Candidate result: ${JSON.stringify(canonical)}`,
        'Semantically verify the candidate before execution. Every target id must exist in Context and match every explicitly named widget kind and ordinal in the instruction. Explicit references outrank focus; focus is usable only when type-compatible. If multiple compatible widgets remain ambiguous, return an ambiguous_target error with a precise natural-language cause. Also verify action direction, magnitude, property schema, and spatial relation. Return the verified or corrected canonical result only.',
    ].join('\n');
    return await requestCanonicalResult(llmAgent, verificationPrompt);
}

export default action;
