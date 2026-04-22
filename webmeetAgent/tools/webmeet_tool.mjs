import {
    attachMeetingAgent,
    appendMeetingChat,
    appendMeetingTranscript,
    closeMeeting,
    createChannel,
    createMeeting,
    createStoreContext,
    createWorkspace,
    joinMeeting,
    listChannels,
    listMeetingAgents,
    listMeetingArtifacts,
    listMeetingChat,
    listMeetings,
    listMeetingTranscript,
    listWorkspaces,
    startMeetingRecording,
    stopMeetingRecording
} from '../lib/webmeetStore.mjs';

const TOOL_NAME = String(process.env.TOOL_NAME || '').trim();
const SUPPORTED_AGENT_TYPES = new Set(['observer', 'assistant_on_mention', 'scribe']);
const SUPPORTED_AGENT_MODES = new Set(['passive', 'on_mention', 'post_event']);

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

function normalizeInput(envelope) {
    let current = envelope;
    for (let i = 0; i < 4; i += 1) {
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

async function readInput() {
    const raw = (await readStdinFallback()).trim();
    if (!raw) return {};
    const parsed = safeParseJson(raw);
    if (!parsed || typeof parsed !== 'object') {
        return {};
    }
    return normalizeInput(parsed);
}

function getRequiredString(args, key) {
    const value = String(args?.[key] || '').trim();
    if (!value) {
        throw new Error(`Missing required argument "${key}".`);
    }
    return value;
}

async function dispatch(toolName, args, context) {
    switch (toolName) {
    case 'webmeet_workspace_list':
        return { workspaces: listWorkspaces(context) };
    case 'webmeet_workspace_create':
        return createWorkspace(context, { name: String(args?.name || '').trim() });
    case 'webmeet_channel_list':
        return { channels: listChannels(context, String(args?.workspaceId || '').trim()) };
    case 'webmeet_channel_create':
        return createChannel(context, {
            workspaceId: String(args?.workspaceId || '').trim(),
            name: getRequiredString(args, 'name'),
            kind: String(args?.kind || 'meeting').trim() || 'meeting'
        });
    case 'webmeet_meeting_list':
        return { meetings: listMeetings(context, getRequiredString(args, 'channelId')) };
    case 'webmeet_meeting_create':
        return createMeeting(context, {
            channelId: getRequiredString(args, 'channelId'),
            title: getRequiredString(args, 'title')
        });
    case 'webmeet_meeting_join':
        return joinMeeting(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            displayName: getRequiredString(args, 'displayName'),
            participantId: String(args?.participantId || '').trim()
        });
    case 'webmeet_chat_list':
        return { messages: listMeetingChat(context, getRequiredString(args, 'meetingId')) };
    case 'webmeet_chat_send':
        return appendMeetingChat(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            authorId: getRequiredString(args, 'authorId'),
            authorName: getRequiredString(args, 'authorName'),
            message: getRequiredString(args, 'message')
        });
    case 'webmeet_transcript_append':
        return appendMeetingTranscript(context, {
            meetingId: getRequiredString(args, 'meetingId'),
            speakerId: getRequiredString(args, 'speakerId'),
            speakerName: getRequiredString(args, 'speakerName'),
            text: getRequiredString(args, 'text')
        });
    case 'webmeet_transcript_list':
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
        return attachMeetingAgent(context, { meetingId, agentType, mode });
    }
    case 'webmeet_agent_list':
        return { agents: listMeetingAgents(context, getRequiredString(args, 'meetingId')) };
    case 'webmeet_recording_start':
        return startMeetingRecording(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_recording_stop':
        return stopMeetingRecording(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_artifact_list':
        return listMeetingArtifacts(context, getRequiredString(args, 'meetingId'));
    case 'webmeet_close_meeting':
        return closeMeeting(context, getRequiredString(args, 'meetingId'));
    default:
        throw new Error(`Unsupported TOOL_NAME "${toolName}".`);
    }
}

async function main() {
    const args = await readInput();
    const context = createStoreContext();
    const result = await dispatch(TOOL_NAME, args, context);
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
});
