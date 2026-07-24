import {
    BLACKBOARD_PUBLIC_ACTIONS,
    getBlackboardWidgetEventSchemaPrompt,
    getBlackboardScriptaEventSchemaPrompt,
    normalizeBlackboardEventResult,
} from '../../../lib/blackboard/event-contract.mjs';
import {
    getBlackboardChatResponseFormat,
    getBlackboardStructuredResultSchema,
    normalizeBlackboardStructuredResult,
} from '../../../lib/blackboard/structured-result-schema.mjs';

function responseValue(response) {
    const value = response?.result ?? response?.content ?? response;
    return typeof value === 'string' ? JSON.parse(value) : value;
}

function discardDerivedFreeLineGeometry(result) {
    const events = Array.isArray(result?.events) ? result.events : [];
    for (const event of events) {
        const widget = event?.action === 'create' ? event.payload?.widget : null;
        const properties = widget?.type === 'line' ? widget.properties : null;
        if (!properties?.line || properties.connection) continue;
        // Free-line endpoints are absolute at the interpreter boundary. Geometry is
        // a server-derived projection, so an LLM-provided zero-height/zero-width
        // bounding box must never reach canonical validation.
        delete properties.geometry;
    }
    return result;
}

async function requestCanonicalResult(llmAgent, prompt) {
    const response = llmAgent.executeStructuredPrompt
        ? await llmAgent.executeStructuredPrompt(prompt, {
            model: 'plan',
            schemaName: 'webmeet_blackboard_result',
            schema: getBlackboardStructuredResultSchema(),
            strict: true,
        })
        : await llmAgent.executePrompt(prompt, {
            responseShape: 'json',
            model: 'plan',
            params: { response_format: getBlackboardChatResponseFormat() },
        });
    return normalizeBlackboardEventResult(discardDerivedFreeLineGeometry(
        normalizeBlackboardStructuredResult(responseValue(response))
    ));
}

async function requestCanonicalResultWithRepairs(llmAgent, prompt, maxAttempts = 3) {
    let attemptPrompt = prompt;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await requestCanonicalResult(llmAgent, attemptPrompt);
        } catch (error) {
            lastError = error;
            if (attempt === maxAttempts) break;
            attemptPrompt = [
                prompt,
                `Your previous result was rejected by the canonical validator: ${String(error?.message || error)}`,
                'Re-evaluate all targets and fields against the exact action schema above. Submit a corrected canonical structured result only. Do not explain the correction.',
            ].join('\n');
        }
    }
    throw lastError;
}

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt && !llmAgent?.executeStructuredPrompt) throw new Error('Blackboard event interpretation requires an LLM agent.');
    const prompt = [
        'Convert the participant instruction into {events:[...]} containing one or more canonical WebMeet blackboard events.',
        'The structured transport has exactly one non-null terminal branch: success is {events:[...],error:null}; failure is {events:null,error:{code:string,message:string}}. Never return both branches null or both branches populated.',
        'Understand the instruction semantically in any language; never match a hardcoded phrase list.',
        'If the instruction cannot be resolved deterministically, return exactly {error:{code:string,message:string}} and no events. Never ask a clarification question. Explain the exact cause naturally in the same language as the instruction. Use one of: ambiguous_target, missing_target, target_type_mismatch, ambiguous_operation, confirmation_required, unsupported_request.',
        `Allowed actions: ${BLACKBOARD_PUBLIC_ACTIONS.join(', ')}.`,
        'Never output add, lock, unlock, or focus. Never output ids for newly created widgets, provenance, participant ids, revisions, command ids, or event ids.',
        'create targets {type:"blackboard"} and uses payload.widget:{type,properties}. Widget updates target an existing widgetId or prior local ref and use payload.patch.properties.',
        'Widgets with the same non-empty groupId form one rigid group. Group operations target {type:"group",groupId}. Move a group with update payload.patch.transform.translation:{x,y}; resize it with transform.resize:{x,y,width,height}; rotate it relatively with transform.rotationDelta. delete removes the whole group and ungroup preserves its final geometry. Never invent a groupId.',
        'Create a group only when every selected widget has capabilities.groupable:true. Interactive widgets such as poll, bullets, embed, and scripta-document are complex standalone widgets and must never be grouped.',
        'Use a unique event.ref on create when a later event in the same command needs that widget. References are ordered and cannot point forward.',
        'Every existing widget has a transient global ordinal. An explicit ordinal reference such as "line 3" targets board.widgets ordinal 3 and must also match the named widget kind. An ordinal reference outranks labels, focus, and lastAffectedWidgetIds. A kind mismatch returns target_type_mismatch.',
        'Compact and speech-transcribed commands may omit punctuation and words such as "by". When a widget kind is followed immediately by a spoken or numeric integer that matches an existing ordinal, prefer that integer as the widget ordinal before interpreting a later amount and unit. Thus "move line one hundred pixels down" means line ordinal 1 moved down by 100 pixels, not an unspecified line moved by 100 pixels. Apply the same ordinal-first rule semantically in every language; do not require the participant to say "number" or "by".',
        'Connections are line widgets with properties.connection.from/to; each endpoint has widgetId or ref and anchor left, right, top, bottom, or center.',
        'Use properties.label for text centered inside a shape. Use a text widget only for independent text.',
        'Canonical widget creation schemas (these are exhaustive; semantic names such as circle are not widget types):',
        getBlackboardWidgetEventSchemaPrompt(),
        'The empty-board logical frame is 1200 by 800. Center against board.contentBounds. Default generated-layout gap is 40 px.',
        'For "right of" a widget, place the new left edge at the target right bound plus the requested gap or 40 px, and align vertical centers. For a free line, its bounds are the min/max of line endpoints.',
        'A circle is shapeKind:"ellipse" with equal width and height; when no diameter is given use 100 by 100. An oval may use unequal width and height.',
        'For relative movement use exactly patch.properties.geometryDelta:{x,y}; never use dx/dy. Down is positive y, up is negative y, right is positive x, and left is negative x. A direction without distance uses 40 px. "larger" without a value means 20 percent.',
        'Rotation uses patch.properties.rotation in degrees. "Rotate by N degrees" is relative: add N to the target widget rotation from Context. "Rotate to N degrees" is absolute. Preserve the target center and do not rewrite free-line endpoints merely to rotate its rendered widget.',
        'A free line MUST use payload.widget.properties.line:{x1,y1,x2,y2,markerStart?,markerEnd?}. These create coordinates are absolute blackboard coordinates. Never put x1, y1, x2, or y2 in properties.geometry.',
        'For a free-line create, omit properties.geometry entirely. The server derives its geometry from properties.line, including the default 1 px render thickness for perfectly horizontal or vertical lines.',
        'For a free line defined by center, length, and angle, calculate both endpoints deterministically with cosine and sine.',
        'When creating or adding a free line while board.focusedWidgetId identifies a free line, and the participant gives no different origin or center, continue from that focused line: use its absolute line.x2/y2 as the new x1/y1 and extend x2/y2 by cos(angle)*length and sin(angle)*length. An explicit origin, center, target, or instruction not to connect takes priority.',
        'For SCRIPTA actions, the event action determines intent kind and operation. Put only the listed fields directly in payload using the exact schema for that action. payload.mutation and every other wrapper object are invalid and must never be emitted. Never put an operation name in payload.type; type is permitted only by the two vote action schemas:',
        getBlackboardScriptaEventSchemaPrompt(),
        '- Vision, Plan, and General are creation templates. Vision requires at least three generated aspect paragraphs; Plan requires generated chapters; General creates one empty chapter and paragraph.',
        'scripta-chapter-edit requires a non-empty title. scripta-document-create requires a name or title. scripta-document-open requires a path.',
        'For a SCRIPTA subelement target, use an explicit chapter/paragraph ordinal or name first. If none is supplied, use the compatible target in widget.scripta.view. A focused paragraph also identifies its containing chapter for chapter operations. Do not return missing_target merely because the instruction omitted a chapter ordinal when the active SCRIPTA view supplies a focused chapter. When the server can resolve the active focus, the event may omit chapterId and paragraphId.',
        'SCRIPTA mutation operations are p-variant-add, p-variant-vote, p-variant-vote-withdraw, p-variant-edit, p-variant-delete, chapter-add, chapter-delete, chapter-rename, chapter-move, paragraph-add, paragraph-delete, paragraph-move, and undo.',
        'Only the participant who added a paragraph variant may edit or delete it. All admitted participants may vote on any variant.',
        'Document operations are document-create, document-open, and document-delete.',
        'Physical document deletion must include confirmed:true only when the participant explicitly confirms deletion; otherwise return error code confirmation_required.',
        'For relative navigation use navigation intent; do not calculate IDs yourself.',
        'For generic widget changes use only the canonical payload schemas; never emit payload.change.',
        'Resolve targets in this order: explicit ordinal, other explicit mention, a semantically compatible focused element, then board.lastAffectedWidgetIds for plural wording. For generic widgets the focus is board.focusedWidgetId; for SCRIPTA subelements it is widget.scripta.view. Absence of an ordinal is not ambiguous when a compatible focus exists. A named widget kind is an explicit constraint: a request naming a line may target only a line, a shape only a shape, and so on. Never use a focused element whose type conflicts with the explicit kind. If multiple compatible widgets remain and neither the instruction nor focus distinguishes one, return ambiguous_target with a precise natural-language cause.',
        'Use only IDs present in context. Never invent path values.',
        'If a target or operation is genuinely ambiguous, return an error with a concise natural-language cause and do not emit events.',
        `Instruction: ${String(promptText || '')}`,
        `Context: ${JSON.stringify(context || {})}`
    ].join('\n');
    const canonical = await requestCanonicalResultWithRepairs(llmAgent, prompt);
    if (canonical.error) return canonical;
    const verificationPrompt = [
        prompt,
        `Candidate result: ${JSON.stringify(canonical)}`,
        'Semantically verify the candidate before execution. Every target id must exist in Context and match every explicitly named widget kind and ordinal in the instruction. Explicit references outrank focus; focus is usable only when type-compatible. If multiple compatible widgets remain ambiguous, return an ambiguous_target error with a precise natural-language cause. Also verify action direction, magnitude, property schema, and spatial relation. Return the verified or corrected canonical result only.',
    ].join('\n');
    return await requestCanonicalResultWithRepairs(llmAgent, verificationPrompt);
}

export default action;
