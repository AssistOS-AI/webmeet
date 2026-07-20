let explorerClientPromise = null;

async function defaultExplorerClient() {
    if (!explorerClientPromise) {
        explorerClientPromise = import('/Agent/client/AgentMcpClient.mjs')
            .then(({ createAgentClient }) => createAgentClient('explorer'));
    }
    return explorerClientPromise;
}

function toMcpJson(value, location = 'arguments') {
    if (value === undefined) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new TypeError(`${location} must contain only finite JSON numbers.`);
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((item, index) => {
            const normalized = toMcpJson(item, `${location}[${index}]`);
            return normalized === undefined ? null : normalized;
        });
    }
    if (typeof value === 'object') {
        return Object.fromEntries(Object.entries(value)
            .map(([key, item]) => [key, toMcpJson(item, `${location}.${key}`)])
            .filter(([, item]) => item !== undefined));
    }
    throw new TypeError(`${location} contains a value that cannot be sent as JSON.`);
}

function toolText(result) {
    if (!Array.isArray(result?.content)) return '';
    return result.content
        .filter((item) => item?.type === 'text')
        .map((item) => String(item.text || ''))
        .join('\n')
        .trim();
}

function unwrapExplorerResult(result, tool) {
    if (!result || typeof result !== 'object' || !Array.isArray(result.content)) {
        return result;
    }
    const text = toolText(result);
    if (result.isError === true) {
        const error = new Error(text || `Explorer tool ${tool} failed.`);
        error.code = 'EXPLORER_TOOL_ERROR';
        error.tool = tool;
        throw error;
    }
    if (!text) return result;
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            const error = new Error(parsed.error?.message || parsed.message || `Explorer tool ${tool} failed.`);
            error.code = parsed.error?.code || 'EXPLORER_TOOL_ERROR';
            error.tool = tool;
            error.data = parsed;
            throw error;
        }
        return parsed;
    } catch (error) {
        if (error?.tool === tool) throw error;
        return result;
    }
}

export async function callScriptaExplorer(context, tool, args) {
    const jsonArgs = toMcpJson(args);
    const injected = context?.scriptaExplorerClient;
    let result;
    if (injected) {
        if (typeof injected === 'function') {
            result = await injected(tool, jsonArgs);
            return unwrapExplorerResult(result, tool);
        }
        if (typeof injected.callTool === 'function') {
            result = await injected.callTool(tool, jsonArgs);
            return unwrapExplorerResult(result, tool);
        }
    }
    const client = await defaultExplorerClient();
    result = await client.callTool(tool, jsonArgs);
    return unwrapExplorerResult(result, tool);
}

export const scriptaExplorer = Object.freeze({
    ensureFolder: (context, args) => callScriptaExplorer(context, 'scripta_crdt_ensure_folder', args),
    listWorkspace: (context, args) => callScriptaExplorer(context, 'scripta_crdt_workspace_list', args),
    create: (context, args) => callScriptaExplorer(context, 'scripta_crdt_create', args),
    open: (context, args) => callScriptaExplorer(context, 'scripta_crdt_open', args),
    mutate: (context, args) => callScriptaExplorer(context, 'scripta_crdt_mutate', args),
    delete: (context, args) => callScriptaExplorer(context, 'scripta_crdt_delete', args),
    collaborationOpen: (context, args) => callScriptaExplorer(context, 'scripta_collaboration_open', args),
    collaborationPull: (context, args) => callScriptaExplorer(context, 'scripta_collaboration_pull', args),
    collaborationApply: (context, args) => callScriptaExplorer(context, 'scripta_collaboration_apply', args),
});
