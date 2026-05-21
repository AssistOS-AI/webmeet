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

function extractInvocationGrant(envelope) {
    const metadata = envelope && typeof envelope === 'object' ? envelope.metadata : null;
    const grant = metadata && typeof metadata === 'object' ? metadata.invocation : null;
    return grant && typeof grant === 'object' ? grant : null;
}

function authInfoFromEnvelope(envelope) {
    const invocationGrant = extractInvocationGrant(envelope || {});
    return invocationGrant
        ? authInfoFromInvocation(invocationGrant, { invocationToken: envelope?.metadata?.invocationToken || '' })
        : null;
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
            return { ...appended, researchTask: null };
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
