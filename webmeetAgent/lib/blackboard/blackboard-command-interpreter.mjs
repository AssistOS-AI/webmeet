import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBlackboardEventResult } from './event-contract.mjs';
import { buildSemanticBoardContext } from './semantic-context.mjs';

const AGENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_COMMAND_INTERPRETATION_TIMEOUT_MS = 60_000;

function commandTimeoutMs(deps = {}) {
    const value = Number(
        deps.timeoutMs
        ?? process.env.WEBMEET_BLACKBOARD_COMMAND_TIMEOUT_MS
        ?? DEFAULT_COMMAND_INTERPRETATION_TIMEOUT_MS
    );
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_COMMAND_INTERPRETATION_TIMEOUT_MS;
}

export class BlackboardCommandInterpreter {
    constructor(deps = {}) {
        this.deps = deps;
    }

    async interpret({ text, board } = {}) {
        const deps = this.deps;
        const Agent = deps.MainAgent || (await import('achillesAgentLib/MainAgent')).MainAgent;
        const agent = new Agent({
            startDir: AGENT_ROOT,
            disableInternalSkills: true,
            modelConfig: process.env.WEBMEET_EVENT_MODEL
                ? { plan: process.env.WEBMEET_EVENT_MODEL, code: process.env.WEBMEET_EVENT_MODEL }
                : null,
        });
        const context = {
            instruction: String(text || ''),
            board: board?.contentBounds ? structuredClone(board) : buildSemanticBoardContext(board || {}),
        };
        let timer;
        try {
            const response = await Promise.race([
                agent.executeSkill('blackboard-event', context.instruction, { context }),
                new Promise((_, reject) => {
                    timer = setTimeout(() => {
                        const error = new Error('Blackboard command interpretation timed out.');
                        error.code = 'command_interpretation_timeout';
                        reject(error);
                    }, commandTimeoutMs(deps));
                }),
            ]);
            return normalizeBlackboardEventResult(response?.result ?? response);
        } finally {
            clearTimeout(timer);
            await agent.shutdown?.();
        }
    }
}

export async function interpretBlackboardCommand(text, context = {}, deps = {}) {
    const board = context.board?.widgets ? context.board : (context.board || {});
    return new BlackboardCommandInterpreter(deps).interpret({ text, board });
}
