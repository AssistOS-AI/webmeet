const memorySchema = {
    type: 'object',
    properties: { memory: { type: 'string', minLength: 1, maxLength: 4_000 } },
    required: ['memory'],
    additionalProperties: false,
};

function responseFormat() {
    return {
        type: 'json_schema',
        json_schema: { name: 'webmeet_meeting_memory', strict: true, schema: memorySchema },
    };
}

function validateMemory(memory) {
    const value = String(memory || '').trim();
    if (!value) throw new Error('Meeting memory compaction returned empty memory.');
    if (value.length > 4_000) throw new Error('Meeting memory compaction returned oversized memory.');
    return value;
}

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt) {
        throw new Error('Meeting memory compaction requires a structured LLM agent.');
    }
    const input = context && typeof context === 'object' ? context : JSON.parse(String(promptText || '{}'));
    const promptParts = [
        'Create one REPLACEMENT cumulative memory for a long meeting.',
        'This is context maintenance, not a notes update and not a summary of only the latest range.',
        'Merge every fact from Previous cumulative memory with the new chronological range.',
        'Preserve speaker attribution, chronology where it changes meaning, corrections, disagreements, rejected or superseded proposals, explicit decisions, owners, deadlines, risks, questions, and unresolved points.',
        'Never invent consensus, ownership, deadlines, or participants.',
        'Be compact but retain details that may change interpretation of future discussion.',
        `Participants: ${JSON.stringify(input.participants || [])}`,
        `Current holistic Markdown notes: ${String(input.currentMarkdown || '')}`,
        `Previous cumulative memory: ${String(input.previousMemory || '')}`,
        `Next chronological transcript range: ${JSON.stringify(input.segments || [])}`,
    ];
    const response = await llmAgent.executePrompt(promptParts.join('\n'), {
        responseShape: 'json',
        params: { response_format: responseFormat() },
    });
    const result = response?.result ?? response?.content ?? response;
    const parsed = typeof result === 'string' ? JSON.parse(result) : result;
    return { memory: validateMemory(parsed?.memory) };
}

export default action;
