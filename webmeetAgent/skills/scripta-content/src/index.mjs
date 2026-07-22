function nullable(schema) {
    return { anyOf: [schema, { type: 'null' }] };
}

function strictObject(properties) {
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

function contentSchema() {
    const paragraph = strictObject({ text: { type: 'string' } });
    const chapter = strictObject({
        title: { type: 'string' },
        paragraphs: { type: 'array', items: paragraph },
    });
    return strictObject({
        text: nullable({ type: 'string' }),
        visionParagraphs: nullable({ type: 'array', items: paragraph }),
        planParagraphs: nullable({ type: 'array', items: paragraph }),
        chapters: nullable({ type: 'array', items: chapter }),
    });
}

function responseFormat() {
    return {
        type: 'json_schema',
        json_schema: {
            name: 'webmeet_scripta_content',
            strict: true,
            schema: contentSchema(),
        },
    };
}

function withoutNullFields(value) {
    if (Array.isArray(value)) return value.map(withoutNullFields);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => (
        entry === null ? [] : [[key, withoutNullFields(entry)]]
    )));
}

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt && !llmAgent?.executeStructuredPrompt) throw new Error('SCRIPTA content generation requires an LLM agent.');
    const input = context && typeof context === 'object'
        ? context
        : JSON.parse(String(promptText || '{}'));
    const instruction = input.task === 'create-scripta-document'
        ? [
            `Create content for a ${String(input.template || 'general')} SCRIPTA document.`,
            `Objective: ${String(input.objective || '')}`,
            String(input.requirements || ''),
            'Vision paragraphs describe distinct aspects of the work and have no paragraph titles.',
            'Plan chapters describe the structure of the intended work.',
        ].join('\n')
        : [
            'Reformulate the selected paragraph as a useful alternative while preserving its meaning and language.',
            `Current paragraph and variants: ${JSON.stringify(input.paragraph || {})}`,
            `Participant instruction: ${String(input.command || '')}`,
        ].join('\n');
    const response = llmAgent.executeStructuredPrompt
        ? await llmAgent.executeStructuredPrompt(instruction, {
            model: 'plan', schemaName: 'webmeet_scripta_content', schema: contentSchema(), strict: true,
        })
        : await llmAgent.executePrompt(instruction, {
            responseShape: 'json', model: 'plan', params: { response_format: responseFormat() },
        });
    const result = response?.result ?? response?.content ?? response;
    return withoutNullFields(typeof result === 'string' ? JSON.parse(result) : result);
}

export default action;
