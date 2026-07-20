const ACTIONS = [
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
];

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt) throw new Error('Blackboard event interpretation requires an LLM agent.');
    const prompt = [
        'Convert the participant instruction into exactly one canonical WebMeet blackboard event.',
        'Understand the instruction semantically in any language; never match a hardcoded phrase list.',
        `Allowed actions: ${ACTIONS.join(', ')}.`,
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
        'Physical document deletion must include confirmed:true only when the participant explicitly confirms deletion; otherwise return clarificationRequired.',
        'For relative navigation use navigation intent; do not calculate IDs yourself.',
        'For a generic widget or board change, payload.change must contain the final blackboard change and must match action and target.',
        'Use only IDs present in context. Never invent path values. A missing create path means the room default folder.',
        'If a target or operation is genuinely ambiguous, return clarificationRequired and a concise question.',
        `Instruction: ${String(promptText || '')}`,
        `Context: ${JSON.stringify(context || {})}`
    ].join('\n');
    const response = await llmAgent.executePrompt(prompt, { responseShape: 'json', model: 'plan' });
    const result = response?.result ?? response?.content ?? response;
    if (typeof result === 'string') return JSON.parse(result);
    return result;
}

export default action;
