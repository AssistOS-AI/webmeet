import { callAgentTool, ensureSuccess, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";

export const WEBMEET_AGENT_NAME = 'webmeetAgent';

export async function runWebMeetTool(name, args = {}) {
    const raw = await callAgentTool(WEBMEET_AGENT_NAME, name, args, { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
}
