import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_INTERPRETATION_TIMEOUT_MS = 60_000;

function interpretationTimeout(deps = {}) {
    const configured = Number(deps.timeoutMs ?? process.env.WEBMEET_EVENT_TIMEOUT_MS ?? DEFAULT_INTERPRETATION_TIMEOUT_MS);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_INTERPRETATION_TIMEOUT_MS;
}

export async function interpretBlackboardEvent(text, context, deps = {}) {
    const Agent = deps.MainAgent || (await import('achillesAgentLib/MainAgent')).MainAgent;
    const agent = new Agent({
        startDir: AGENT_ROOT,
        disableInternalSkills: true,
        modelConfig: process.env.WEBMEET_EVENT_MODEL
            ? { plan: process.env.WEBMEET_EVENT_MODEL, code: process.env.WEBMEET_EVENT_MODEL }
            : null
    });
    let timeout;
    try {
        const response = await Promise.race([
            agent.executeSkill('blackboard-event', String(text || ''), { context }),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error('Blackboard event interpretation timed out.');
                    error.code = 'event_interpretation_timeout';
                    reject(error);
                }, interpretationTimeout(deps));
            })
        ]);
        return response?.result ?? response;
    } finally {
        clearTimeout(timeout);
        agent.shutdown();
    }
}
