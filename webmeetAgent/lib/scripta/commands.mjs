const INTENT_KINDS = new Set(['document', 'focus', 'navigation', 'mutation', 'ai-reformulate']);
const DOCUMENT_OPERATIONS = new Set(['document-create', 'document-open', 'document-delete']);
const MUTATION_OPERATIONS = new Set([
    'p-variant-add', 'p-variant-vote', 'p-variant-vote-withdraw', 'p-variant-edit',
    'p-variant-delete', 'chapter-add', 'chapter-delete',
    'chapter-rename', 'chapter-move', 'paragraph-add', 'paragraph-delete', 'paragraph-move', 'undo',
]);

function optionalString(value) {
    return String(value || '').trim();
}

function optionalOrdinal(value) {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number.parseInt(String(value), 10);
    return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeParagraphs(value) {
    if (!Array.isArray(value)) return [];
    return value.map((paragraph) => ({ text: String(paragraph?.text ?? '') }));
}

function normalizeChapters(value) {
    if (!Array.isArray(value)) return [];
    return value.map((chapter) => ({ title: optionalString(chapter?.title), paragraphs: normalizeParagraphs(chapter?.paragraphs) }));
}

export function assertRoboCommand(input = '') {
    const text = String(input || '').trim();
    if (!/^\/robo(?:\s|$)/i.test(text)) throw new Error('Robo commands must start with /robo.');
    const command = text.replace(/^\/robo\s*/i, '').trim();
    if (!command) {
        const error = new Error('Comanda /robo nu conține nicio instrucțiune.');
        error.code = 'missing_instruction';
        throw error;
    }
    return { command };
}

export function normalizeRoboIntent(value = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SCRIPTA AI returned an invalid command intent.');
    const kind = optionalString(value.kind).toLowerCase();
    if (!INTENT_KINDS.has(kind)) throw new Error('SCRIPTA AI returned an unsupported command kind.');
    const intent = {
        kind,
        operation: optionalString(value.operation).toLowerCase(),
        resourceId: optionalString(value.resourceId),
        chapterId: optionalString(value.chapterId),
        paragraphId: optionalString(value.paragraphId),
        variantId: optionalString(value.variantId),
        chapterOrdinal: optionalOrdinal(value.chapterOrdinal),
        paragraphOrdinal: optionalOrdinal(value.paragraphOrdinal),
        targetChapterOrdinal: optionalOrdinal(value.targetChapterOrdinal),
        targetIndex: value.targetIndex === 0 ? 0 : optionalOrdinal(value.targetIndex),
        variantOrdinal: optionalOrdinal(value.variantOrdinal),
        name: optionalString(value.name),
        path: optionalString(value.path),
        folderPath: optionalString(value.folderPath),
        template: optionalString(value.template).toLowerCase() || 'general',
        objective: optionalString(value.objective),
        title: optionalString(value.title),
        text: String(value.text ?? ''),
        type: optionalString(value.type).toLowerCase(),
        mode: optionalString(value.mode).toLowerCase(),
        direction: optionalString(value.direction).toLowerCase(),
        confirmed: value.confirmed === true,
        editing: value.editing === true ? true : value.editing === false ? false : undefined,
        visionParagraphs: normalizeParagraphs(value.visionParagraphs),
        planParagraphs: normalizeParagraphs(value.planParagraphs),
        chapters: normalizeChapters(value.chapters),
    };
    if (kind === 'document' && !DOCUMENT_OPERATIONS.has(intent.operation)) throw new Error('SCRIPTA AI returned an unsupported document operation.');
    if (kind === 'mutation' && !MUTATION_OPERATIONS.has(intent.operation)) throw new Error('SCRIPTA AI returned an unsupported mutation operation.');
    if (kind === 'mutation' && intent.operation === 'chapter-rename' && !intent.title) {
        throw new Error('SCRIPTA chapter rename requires a non-empty title.');
    }
    if (intent.type && !['like', 'dislike'].includes(intent.type)) throw new Error('SCRIPTA AI returned an unsupported vote type.');
    return intent;
}
