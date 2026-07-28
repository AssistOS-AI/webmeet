export const WEBMEET_AGENT_NAME = 'webmeetAgent';

export class WebMeetToolError extends Error {
    constructor(code, message, data = null) {
        super(message);
        this.name = 'WebMeetToolError';
        this.code = code;
        this.data = data;
    }
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

function parseJsonObject(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string') {
        return null;
    }
    const text = value.trim();
    if (!text) {
        return null;
    }
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (_) {
        return null;
    }
}

function unwrapMcpToolResult(value) {
    const parsed = parseJsonObject(value);
    const result = parsed?.result && typeof parsed.result === 'object' ? parsed.result : parsed;
    const content = Array.isArray(result?.content) ? result.content : [];
    const textEntry = content.find((entry) => entry?.type === 'text' && typeof entry.text === 'string');
    return parseJsonObject(textEntry?.text) || result || {};
}

function extractToolText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload;
    const blocks = Array.isArray(payload.content) ? payload.content : null;
    if (blocks) {
        const textBlock = blocks.find((block) => block?.type === 'text' && typeof block.text === 'string');
        if (textBlock?.text) return textBlock.text;
    }
    if (typeof payload.text === 'string') return payload.text;
    return '';
}

function extractErrorMessage(value, fallback = 'Tool execution failed') {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (!value || typeof value !== 'object') return fallback;
    if (typeof value.message === 'string' && value.message.trim()) return value.message.trim();
    if (value.error !== undefined) return extractErrorMessage(value.error, fallback);
    if (typeof value.code === 'string' && value.code.trim()) return value.code.trim();
    return fallback;
}

function ensureSuccess(payload) {
    if (payload && typeof payload === 'object' && payload.isError === true) {
        const text = extractToolText(payload).trim();
        throw new WebMeetToolError('tool_error', text || 'Tool execution failed', { payload });
    }
    const text = extractToolText(payload);
    if (typeof text === 'string' && text.trim().startsWith('Error:')) {
        throw new WebMeetToolError('tool_error', text.trim().replace(/^Error:\s*/i, ''), { payload });
    }
    const parsed = unwrapMcpToolResult(payload);
    if (parsed && typeof parsed === 'object' && parsed.ok === false) {
        const errorCode = typeof parsed.error?.code === 'string' ? parsed.error.code : 'tool_error';
        throw new WebMeetToolError(errorCode, extractErrorMessage(parsed.error), parsed);
    }
}

function getWebMeetClient() {
    const client = window.webSkel?.appServices?.getClient?.(WEBMEET_AGENT_NAME);
    if (!client || typeof client.callTool !== 'function') {
        throw new WebMeetToolError('client_unavailable', `Agent client not available: ${WEBMEET_AGENT_NAME}`);
    }
    return client;
}

export async function runWebMeetTool(name, args = {}) {
    const toolName = String(name || '').trim();
    const raw = await getWebMeetClient().callTool(toolName, normalizeArgs(toolName, args));
    ensureSuccess(raw);
    return normalizeResult(unwrapMcpToolResult(raw));
}
