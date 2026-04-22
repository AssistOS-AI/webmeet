let llmModulePromise = null;

async function loadLlmModule() {
    if (!llmModulePromise) {
        llmModulePromise = import('achillesAgentLib/LLMAgents').catch(() => null);
    }
    return llmModulePromise;
}

async function getDefaultAgent() {
    const module = await loadLlmModule();
    if (!module) {
        return null;
    }
    return (typeof module.getDefaultLLMAgent === 'function' && module.getDefaultLLMAgent())
        || (typeof module.registerDefaultLLMAgent === 'function' && module.registerDefaultLLMAgent());
}

function stripFences(text) {
    return String(text || '')
        .trim()
        .replace(/^```(?:json|text)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();
}

function parseJsonBlock(text) {
    return JSON.parse(stripFences(text));
}

async function executePrompt(prompt, { responseShape = 'text', mode = 'fast' } = {}) {
    const agent = await getDefaultAgent();
    if (!agent || typeof agent.executePrompt !== 'function') {
        throw new Error('No default LLM agent available.');
    }
    return agent.executePrompt(prompt, { mode, responseShape });
}

function buildAssistantPrompt({ agentName, meetingTitle, observerSummary, transcriptText, tasks, decisions, userMessage }) {
    return [
        `You are ${agentName}, an AI meeting assistant.`,
        'Respond only to the direct user request.',
        'Keep the response concise, factual, and grounded in the meeting context.',
        'Do not invent unsupported tasks or decisions.',
        '',
        `Meeting title: ${meetingTitle}`,
        `Observer summary: ${observerSummary || 'None yet.'}`,
        `Known decisions: ${decisions.length ? decisions.join('; ') : 'None'}`,
        `Known tasks: ${tasks.length ? tasks.join('; ') : 'None'}`,
        '',
        'Recent transcript and chat context:',
        transcriptText || 'No transcript yet.',
        '',
        `Direct request: ${userMessage}`,
        '',
        'Return plain text only.'
    ].join('\n');
}

function buildObserverPrompt({ meetingTitle, transcriptText, chatText, previousSummary }) {
    return [
        'You are a passive meeting observer.',
        'Summarize the current project context for long-term memory.',
        'Capture topics, decisions, action items, and open questions.',
        'Do not address users directly.',
        '',
        `Meeting title: ${meetingTitle}`,
        `Previous observer summary: ${previousSummary || 'None'}`,
        '',
        'Recent chat:',
        chatText || 'No chat.',
        '',
        'Recent transcript:',
        transcriptText || 'No transcript.',
        '',
        'Return concise plain text with sections: Topics, Decisions, Tasks, Open Questions.'
    ].join('\n');
}

function buildScribePrompt({ meetingTitle, chatText, transcriptText, observerSummary }) {
    return [
        'You are a meeting scribe.',
        'Produce structured meeting outputs from the provided context.',
        'Return strict JSON with this schema:',
        '{"summary":"string","decisions":["string"],"tasks":[{"title":"string","status":"open"}]}',
        'Do not wrap JSON in markdown fences.',
        '',
        `Meeting title: ${meetingTitle}`,
        `Observer summary: ${observerSummary || 'None'}`,
        '',
        'Chat:',
        chatText || 'No chat.',
        '',
        'Transcript:',
        transcriptText || 'No transcript.'
    ].join('\n');
}

export async function generateAssistantReply(input) {
    const raw = await executePrompt(buildAssistantPrompt(input), { responseShape: 'text', mode: 'fast' });
    return stripFences(raw);
}

export async function generateObserverSummary(input) {
    const raw = await executePrompt(buildObserverPrompt(input), { responseShape: 'text', mode: 'fast' });
    return stripFences(raw);
}

export async function generateScribeOutput(input) {
    const raw = await executePrompt(buildScribePrompt(input), { responseShape: 'text', mode: 'fast' });
    return parseJsonBlock(raw);
}
