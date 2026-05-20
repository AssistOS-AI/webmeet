import { pathToFileURL } from 'node:url';

import {
    attachMeetingAgent,
    appendMeetingChat,
    appendMeetingTranscript,
    createMeeting,
    createStoreContext,
    createWorkspace,
    deleteMeeting,
    detachMeetingAgent,
    getMeeting,
    isAdminAuthInfo,
    joinGuestMeeting,
    joinMeeting,
    leaveMeeting,
    pingMeetingPresence,
    listMeetingAgents,
    listMeetingArtifacts,
    listMeetingChat,
    listMeetingEvents,
    listMeetings,
    listMeetingTranscript,
    listWorkspaceEvents,
    listWorkspaces,
    startMeetingRecording,
    stopMeetingRecording,
    updateMeetingParticipantAvatar,
    updateMeetingTitle
} from '../lib/webmeetStore.mjs';

const DEFAULT_TAG_RELAY_TIMEOUT_MS = 450000;

async function loadInvocationAuth() {
    const candidates = [
        process.env.PLOINKY_INVOCATION_AUTH_MODULE,
        '/Agent/lib/invocation-auth.mjs',
        '../../shared/invocation-auth.mjs'
    ].filter(Boolean);
    for (const candidate of candidates) {
        try {
            return await import(candidate);
        } catch (_) {}
    }
    throw new Error('Unable to load invocation-auth helper.');
}

const { authInfoFromInvocation } = await loadInvocationAuth();

const TOOL_NAME = String(process.env.TOOL_NAME || '').trim();
const SUPPORTED_AGENT_TYPES = new Set(['observer', 'assistant_on_mention', 'scribe']);
const SUPPORTED_AGENT_MODES = new Set(['passive', 'on_mention', 'post_event']);
const TAG_RELAY_MENTION_RE = /(^|\s)@([A-Za-z][A-Za-z0-9_-]{0,63})(?=\s|$|[.,:;!?])/;

function assertAdminTool(authInfo) {
    if (!isAdminAuthInfo(authInfo)) {
        throw new Error('Access denied: only admin can access meeting artifacts.');
    }
}

function safeParseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

async function readStdinFallback() {
    if (process.stdin.isTTY) {
        return '';
    }
    process.stdin.setEncoding('utf8');
    let data = '';
    for await (const chunk of process.stdin) {
        data += chunk;
    }
    return data;
}

function unwrapInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 6; i += 1) {
        if (!current || typeof current !== 'object') break;
        if (current.input && typeof current.input === 'object') {
            current = current.input;
            continue;
        }
        if (current.arguments && typeof current.arguments === 'object') {
            current = current.arguments;
            continue;
        }
        if (current.params?.arguments && typeof current.params.arguments === 'object') {
            current = current.params.arguments;
            continue;
        }
        if (current.params?.input && typeof current.params.input === 'object') {
            current = current.params.input;
            continue;
        }
        break;
    }
    return current && typeof current === 'object' ? current : {};
}

async function readEnvelope() {
    const raw = (await readStdinFallback()).trim();
    if (!raw) return {};
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    return parsed;
}

function getRequiredString(args, key) {
    const value = String(args?.[key] || '').trim();
    if (!value) {
        throw new Error(`Missing required argument "${key}".`);
    }
    return value;
}

function boolFromFlag(value) {
    return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function firstEnvValue(env, names) {
    for (const name of names) {
        if (Object.hasOwn(env, name) && String(env[name] || '').trim()) {
            return String(env[name]).trim();
        }
    }
    return '';
}

function normalizeTagList(value) {
    return new Set(String(value || '')
        .split(/[,\s]+/)
        .map((entry) => entry.trim().replace(/^@+/, '').toLowerCase())
        .filter((entry) => /^[a-z][a-z0-9_-]{0,63}$/.test(entry)));
}

export function resolveTagRelayConfig(env = process.env) {
    const enabledFlag = firstEnvValue(env, [
        'WEBMEET_RESEARCH_TAGS',
        'WEBMEET_TAG_RELAY',
        'TAG_RELAY_ENABLED',
        'RESEARCH_TAGS'
    ]);
    const tags = normalizeTagList(firstEnvValue(env, [
        'WEBMEET_TAG_RELAY_TAGS',
        'WEBMEET_RESEARCH_RELAY_TAGS',
        'TAG_RELAY_TAGS',
        'RESEARCH_RELAY_TAGS'
    ]));
    const timeoutMs = Number(firstEnvValue(env, [
        'WEBMEET_TAG_RELAY_TIMEOUT_MS',
        'TAG_RELAY_TIMEOUT_MS'
    ])) || DEFAULT_TAG_RELAY_TIMEOUT_MS;
    return {
        enabled: enabledFlag ? boolFromFlag(enabledFlag) : tags.size > 0,
        agent: firstEnvValue(env, ['WEBMEET_TAG_RELAY_AGENT', 'WEBMEET_RESEARCH_RELAY_AGENT', 'TAG_RELAY_AGENT']),
        submitTool: firstEnvValue(env, ['WEBMEET_TAG_RELAY_SUBMIT_TOOL', 'WEBMEET_RESEARCH_RELAY_TOOL', 'TAG_RELAY_SUBMIT_TOOL']),
        listTool: firstEnvValue(env, ['WEBMEET_TAG_RELAY_LIST_TOOL', 'WEBMEET_RESEARCH_RELAY_LIST_TOOL', 'TAG_RELAY_LIST_TOOL']),
        tags,
        timeoutMs,
        kind: 'research'
    };
}

function extractInvocationGrant(envelope) {
    const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
    const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
    return grant && typeof grant === 'object' ? grant : null;
}

function extractInvocationToken(envelope) {
    return typeof envelope?.metadata?.invocationToken === 'string'
        ? envelope.metadata.invocationToken
        : '';
}

function authInfoFromEnvelope(envelope) {
    const invocationGrant = extractInvocationGrant(envelope || {});
    return invocationGrant
        ? authInfoFromInvocation(invocationGrant, { invocationToken: envelope?.metadata?.invocationToken || '' })
        : null;
}

function resolveRouterUrl() {
    const explicit = String(process.env.PLOINKY_ROUTER_URL || '').trim();
    if (explicit) return explicit.replace(/\/$/, '');
    const host = String(process.env.PLOINKY_ROUTER_HOST || '127.0.0.1').trim() || '127.0.0.1';
    const port = String(process.env.PLOINKY_ROUTER_PORT || '8080').trim() || '8080';
    return `http://${host}:${port}`;
}

async function callAgentTool(agent, toolName, input, invocationToken, options = {}) {
    if (!invocationToken) {
        throw new Error('Missing invocation token for delegated research task.');
    }
    const url = new URL(`/mcps/${encodeURIComponent(agent)}/mcp`, resolveRouterUrl());
    const controller = new AbortController();
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TAG_RELAY_TIMEOUT_MS);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                accept: 'application/json',
                'x-ploinky-caller-jwt': invocationToken
            },
            signal: controller.signal,
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: Date.now(),
                method: 'tools/call',
                params: {
                    name: toolName,
                    arguments: input || {}
                }
            })
        });
        const text = await response.text();
        const parsed = text ? safeParseJson(text) : null;
        if (!parsed) {
            const bodyText = String(text || '').trim();
            if (response.status === 404 && /API Route not found|Endpoint not found/i.test(bodyText)) {
                throw new Error(`Research relay agent "${agent}" is not routed by Ploinky. Enable copilot-agents/research-agents and restart the workspace before using @open-interpreter from WebMeet.`);
            }
            throw new Error(`invalid MCP response from ${agent}: ${bodyText || `HTTP ${response.status}`}`);
        }
        if (!response.ok) {
            throw new Error(parsed?.error?.message || `Router responded ${response.status}`);
        }
        if (parsed?.error) {
            throw new Error(parsed.error.message || 'Research relay call failed.');
        }
        return parsed;
    } finally {
        clearTimeout(timer);
    }
}

function extractToolJson(response) {
    const content = response?.result?.content;
    const text = Array.isArray(content)
        ? content.filter((entry) => entry?.type === 'text' && typeof entry.text === 'string').map((entry) => entry.text).join('\n')
        : '';
    if (!text.trim()) {
        return {};
    }
    return JSON.parse(text);
}

export function parseTagRelayMention(message) {
    const value = String(message || '');
    const match = value.match(TAG_RELAY_MENTION_RE);
    if (!match) return null;
    const tag = match[2].toLowerCase();
    const start = match.index + match[1].length;
    const prompt = `${value.slice(0, start)}${value.slice(start + tag.length + 1)}`
        .replace(/\s{2,}/g, ' ')
        .trim();
    return { tag, prompt: prompt || value.trim() };
}

function tagsFromBackends(payload) {
    const tags = new Set();
    for (const backend of Array.isArray(payload?.backends) ? payload.backends : []) {
        if (typeof backend?.id === 'string' && backend.id.trim()) {
            tags.add(backend.id.trim().replace(/^@+/, '').toLowerCase());
        }
        for (const tag of Array.isArray(backend?.tags) ? backend.tags : []) {
            if (typeof tag === 'string' && tag.trim()) {
                tags.add(tag.trim().replace(/^@+/, '').toLowerCase());
            }
        }
    }
    return tags;
}

async function resolveKnownResearchTags(config, invocationToken) {
    if (config.tags.size > 0) {
        return config.tags;
    }
    if (!config.listTool) {
        return null;
    }
    const response = await callAgentTool(config.agent, config.listTool, {}, invocationToken, {
        timeoutMs: Math.min(config.timeoutMs, 30000)
    });
    return tagsFromBackends(extractToolJson(response));
}

function makeResearchRelayError(message, tag) {
    const error = new Error(message);
    error.researchTag = tag || '';
    return error;
}

function deriveAuthChatAuthor(authInfo = null) {
    if (!authInfo || typeof authInfo !== 'object') {
        return null;
    }
    const user = authInfo.user && typeof authInfo.user === 'object' ? authInfo.user : authInfo;
    const agent = authInfo.agent && typeof authInfo.agent === 'object' ? authInfo.agent : null;
    const authorId = String(user.id || agent?.principalId || authInfo.principalId || user.username || user.email || '').trim();
    if (!authorId) {
        return null;
    }
    return {
        authorId,
        authorName: String(user.name || user.username || user.email || authorId).trim() || authorId
    };
}

function assertUserChatAuthor(args, authInfo = null) {
    const authAuthor = deriveAuthChatAuthor(authInfo);
    if (authAuthor) {
        return authAuthor;
    }
    const authorId = getRequiredString(args, 'authorId');
    if (authorId.toLowerCase().startsWith('research:')) {
        throw new Error('The research: author prefix is reserved for relay-generated messages.');
    }
    return {
        authorId,
        authorName: getRequiredString(args, 'authorName')
    };
}

async function maybeDispatchResearchTask({ context, args, author, invocationToken }) {
    const config = resolveTagRelayConfig();
    if (!config.enabled || !config.agent || !config.submitTool) {
        return null;
    }
    const parsed = parseTagRelayMention(args?.message);
    if (!parsed) {
        return null;
    }
    let knownTags = null;
    try {
        knownTags = await resolveKnownResearchTags(config, invocationToken);
    } catch {
        return null;
    }
    if (knownTags && !knownTags.has(parsed.tag)) {
        return null;
    }
    const response = await callAgentTool(config.agent, config.submitTool, {
        backend: parsed.tag,
        prompt: parsed.prompt,
        origin: {
            type: config.kind,
            surface: 'webmeet',
            meetingId: getRequiredString(args, 'meetingId'),
            authorId: author.authorId,
            authorName: author.authorName
        }
    }, invocationToken, { timeoutMs: config.timeoutMs }).catch((error) => {
        throw makeResearchRelayError(error?.message || 'Tagged research task failed.', parsed.tag);
    });
    const result = extractToolJson(response);
    const finalAnswer = String(result.final_answer || result.natural_language_output || result.error || '').trim()
        || 'Research task completed without a response.';
    await appendMeetingChat(context, {
        meetingId: getRequiredString(args, 'meetingId'),
        authorId: `research:${result.backend || parsed.tag}`,
        authorName: result.label || `@${parsed.tag}`,
        message: finalAnswer,
        kind: 'agent',
        metadata: {
            researchTask: {
                backend: result.backend || parsed.tag,
                jobId: result.jobId || null,
                sandboxOk: Boolean(result.sandbox_ok),
                backendOk: Boolean(result.backend_ok)
            }
        }
    });
    return result;
}

export async function dispatch(toolName, args, context, authInfo) {
    switch (toolName) {
    case 'webmeet_workspace_list':
        return { workspaces: listWorkspaces(context) };
    case 'webmeet_workspace_create':
        return createWorkspace(context, { name: String(args?.name || '').trim() });
    case 'webmeet_meeting_list':
        return {
            meetings: listMeetings(context, getRequiredString(args, 'workspaceId'), authInfo),
            canManageRooms: isAdminAuthInfo(authInfo)
        };
    case 'webmeet_meeting_create':
        return createMeeting(context, {
            workspaceId: getRequiredString(args, 'workspaceId'),
            title: getRequiredString(args, 'title'),
            roomType: String(args?.roomType || 'team').trim(),
            authInfo
        });
    case 'webmeet_meeting_join':
        return joinMeeting(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            displayName: String(args?.displayName || '').trim(),
            participantId: String(args?.participantId || '').trim(),
            avatar: args?.avatar || null,
            authInfo
        });
    case 'webmeet_meeting_join_guest':
        return joinGuestMeeting(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            guestToken: getRequiredString(args, 'guestToken'),
            displayName: getRequiredString(args, 'displayName'),
            participantId: String(args?.participantId || '').trim()
        });
    case 'webmeet_meeting_leave':
        return leaveMeeting(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            participantId: getRequiredString(args, 'participantId')
        });
    case 'webmeet_meeting_presence_ping':
        return pingMeetingPresence(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            participantId: getRequiredString(args, 'participantId')
        });
    case 'webmeet_workspace_events_list':
        return {
            events: listWorkspaceEvents(context, getRequiredString(args, 'workspaceId'), {
                afterId: String(args?.afterId || '').trim()
            })
        };
    case 'webmeet_meeting_events_list':
        await getMeeting(context, getRequiredString(args, 'meetingId'), authInfo);
        return {
            events: listMeetingEvents(context, getRequiredString(args, 'meetingId'), {
                afterId: String(args?.afterId || '').trim()
            })
        };
    case 'webmeet_participant_avatar_update':
        return updateMeetingParticipantAvatar(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            participantId: getRequiredString(args, 'participantId'),
            avatar: args?.avatar || null,
            authInfo
        });
    case 'webmeet_meeting_get':
        return await getMeeting(context, getRequiredString(args, 'meetingId'), authInfo);
    case 'webmeet_meeting_rename':
        return updateMeetingTitle(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            title: getRequiredString(args, 'title'),
            authInfo
        });
    case 'webmeet_chat_list':
        return { messages: listMeetingChat(context, getRequiredString(args, 'meetingId')) };
    case 'webmeet_chat_send':
        {
            const author = assertUserChatAuthor(args, authInfo);
            const appended = await appendMeetingChat(context, {
                meetingId: getRequiredString(args, 'meetingId'),
                authorId: author.authorId,
                authorName: author.authorName,
                message: getRequiredString(args, 'message')
            });
            let researchTask = null;
            try {
                researchTask = await maybeDispatchResearchTask({
                    context,
                    args,
                    author,
                    invocationToken: extractInvocationToken(context.envelope)
                });
            } catch (error) {
                const tag = error?.researchTag || parseTagRelayMention(args?.message)?.tag || 'relay';
                if (tag) {
                    researchTask = { ok: false, backend: tag, error: error?.message || String(error) };
                    await appendMeetingChat(context, {
                        meetingId: getRequiredString(args, 'meetingId'),
                        authorId: 'research:relay',
                        authorName: 'Research Relay',
                        message: `[research task error] ${researchTask.error}`,
                        kind: 'agent',
                        metadata: { researchTask }
                    });
                }
            }
            return { ...appended, researchTask };
        }
    case 'webmeet_transcript_append':
        assertAdminTool(authInfo);
        return appendMeetingTranscript(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            speakerId: getRequiredString(args, 'speakerId'),
            speakerName: getRequiredString(args, 'speakerName'),
            text: getRequiredString(args, 'text')
        });
    case 'webmeet_transcript_list':
        assertAdminTool(authInfo);
        return { transcript: listMeetingTranscript(context, getRequiredString(args, 'meetingId')) };
    case 'webmeet_agent_attach': {
        const meetingId = getRequiredString(args, 'meetingId');
        const agentType = getRequiredString(args, 'agentType');
        const mode = getRequiredString(args, 'mode');
        if (!SUPPORTED_AGENT_TYPES.has(agentType)) {
            throw new Error(`Unsupported agentType "${agentType}".`);
        }
        if (!SUPPORTED_AGENT_MODES.has(mode)) {
            throw new Error(`Unsupported mode "${mode}".`);
        }
        return attachMeetingAgent(context, { meetingId, agentType, mode, authInfo });
    }
    case 'webmeet_agent_list':
        assertAdminTool(authInfo);
        return { agents: listMeetingAgents(context, getRequiredString(args, 'meetingId')) };
    case 'webmeet_agent_detach':
        return detachMeetingAgent(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            agentId: getRequiredString(args, 'agentId'),
            authInfo
        });
    case 'webmeet_recording_start':
        assertAdminTool(authInfo);
        return startMeetingRecording(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_recording_stop':
        assertAdminTool(authInfo);
        return stopMeetingRecording(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_artifact_list':
        assertAdminTool(authInfo);
        return listMeetingArtifacts(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_delete_meeting':
        return deleteMeeting(context, getRequiredString(args, 'meetingId'), authInfo);
    default:
        throw new Error(`Unsupported TOOL_NAME "${toolName}".`);
    }
}

async function main() {
    const envelope = await readEnvelope();
    const args = unwrapInput(envelope);
    const authInfo = authInfoFromEnvelope(envelope);
    const context = createStoreContext();
    context.envelope = envelope;
    const result = await dispatch(TOOL_NAME, args, context, authInfo);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
