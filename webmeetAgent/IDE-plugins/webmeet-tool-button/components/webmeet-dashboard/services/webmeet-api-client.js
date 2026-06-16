export const WEBMEET_AGENT_NAME = 'webmeetAgent';

function getWebMeetAgentName() {
    return String(globalThis.__WEBMEET_AGENT_NAME__ || WEBMEET_AGENT_NAME).trim() || WEBMEET_AGENT_NAME;
}

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
    const appServices = globalThis.assistOS?.appServices || globalThis.assistOS?.services || null;
    if (!appServices || typeof appServices.callTool !== 'function') {
        throw new Error('WebMeet MCP client is not available.');
    }
    const result = await appServices.callTool(getWebMeetAgentName(), toolName, normalizeArgs(toolName, args));
    if (result?.json && typeof result.json === 'object') {
        return normalizeResult(result.json);
    }
    if (typeof result?.text === 'string' && result.text.trim()) {
        try {
            const parsed = JSON.parse(result.text);
            return normalizeResult(parsed && typeof parsed === 'object' ? parsed : {});
        } catch (_) {
            return normalizeResult({ text: result.text });
        }
    }
    return normalizeResult(result && typeof result === 'object' ? result : {});
}
