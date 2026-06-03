export const WEBMEET_AGENT_NAME = 'webmeetAgent';

function normalizeArgs(toolName, args = {}) {
    const next = { ...(args && typeof args === 'object' ? args : {}) };
    if (next.meetingId !== undefined && next.roomId === undefined) {
        next.roomId = next.meetingId;
        delete next.meetingId;
    }
    if (next.title !== undefined && next.name === undefined) {
        next.name = next.title;
        delete next.title;
    }
    delete next.workspaceId;
    return next;
}

function normalizeResult(result = {}) {
    if (!result || typeof result !== 'object') return {};
    if (Array.isArray(result.rooms) && !Array.isArray(result.meetings)) {
        return { ...result, meetings: result.rooms };
    }
    return result;
}

export async function runWebMeetTool(name, args = {}) {
    const toolName = String(name || '').trim();
    const { callAgentTool, ensureSuccess, parseToolResult } = await import('/explorer/services/infrastructure/explorerApi.js');
    const raw = await callAgentTool(WEBMEET_AGENT_NAME, toolName, normalizeArgs(toolName, args), { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw);
    return normalizeResult(parsed && typeof parsed === 'object' ? parsed : {});
}
