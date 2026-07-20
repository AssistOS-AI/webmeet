export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt) throw new Error('SCRIPTA content generation requires an LLM agent.');
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
    const response = await llmAgent.executePrompt(instruction, {
        responseShape: 'json',
        model: 'plan',
    });
    const result = response?.result ?? response?.content ?? response;
    return typeof result === 'string' ? JSON.parse(result) : result;
}

export default action;
