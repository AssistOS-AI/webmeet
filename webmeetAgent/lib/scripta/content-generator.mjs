import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_CONTENT_TIMEOUT_MS = 60_000;

function contentTimeout(deps = {}) {
    const configured = Number(
        deps.timeoutMs
        ?? process.env.WEBMEET_SCRIPTA_CONTENT_TIMEOUT_MS
        ?? process.env.WEBMEET_EVENT_TIMEOUT_MS
        ?? DEFAULT_CONTENT_TIMEOUT_MS
    );
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_CONTENT_TIMEOUT_MS;
}

export async function generateScriptaContent(input, deps = {}) {
    const Agent = deps.MainAgent || (await import('achillesAgentLib/MainAgent')).MainAgent;
    const agent = new Agent({
        startDir: AGENT_ROOT,
        disableInternalSkills: true,
        modelConfig: process.env.WEBMEET_EVENT_MODEL
            ? { plan: process.env.WEBMEET_EVENT_MODEL, code: process.env.WEBMEET_EVENT_MODEL }
            : null,
    });
    let timeout;
    try {
        const response = await Promise.race([
            agent.executeSkill('scripta-content', JSON.stringify(input || {}), {
                context: input || {},
            }),
            new Promise((_, reject) => {
                timeout = setTimeout(() => {
                    const error = new Error('SCRIPTA content generation timed out.');
                    error.code = 'scripta_content_timeout';
                    reject(error);
                }, contentTimeout(deps));
            })
        ]);
        return response?.result ?? response;
    } finally {
        clearTimeout(timeout);
        agent.shutdown();
    }
}
