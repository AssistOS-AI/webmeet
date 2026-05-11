import { fileURLToPath } from 'node:url';

import * as livekitAgents from '@livekit/agents';

const AGENT_NAME = String(process.env.WEBMEET_LIVEKIT_AGENT_NAME || 'webmeet-agent').trim() || 'webmeet-agent';
const DISPLAY_NAME = String(process.env.WEBMEET_AGENT_NAME || 'WebMeetAgent').trim() || 'WebMeetAgent';
const API_PORT = Number.parseInt(process.env.WEBMEET_API_PORT || '8791', 10);
const API_BASE_URL = String(process.env.WEBMEET_AGENT_API_URL || `http://127.0.0.1:${API_PORT}`).replace(/\/+$/g, '');

function normalizeLiveKitWsUrl(value) {
    const raw = String(value || '').trim().replace(/\/+$/g, '');
    if (!raw) return '';
    if (raw.startsWith('https://')) return `wss://${raw.slice(8)}`;
    if (raw.startsWith('http://')) return `ws://${raw.slice(7)}`;
    return raw;
}

if (!process.env.LIVEKIT_URL && process.env.WEBMEET_LIVEKIT_URL) {
    process.env.LIVEKIT_URL = normalizeLiveKitWsUrl(process.env.WEBMEET_LIVEKIT_URL);
}
if (!process.env.LIVEKIT_API_KEY && process.env.WEBMEET_LIVEKIT_API_KEY) {
    process.env.LIVEKIT_API_KEY = process.env.WEBMEET_LIVEKIT_API_KEY;
}
if (!process.env.LIVEKIT_API_SECRET && process.env.WEBMEET_LIVEKIT_API_SECRET) {
    process.env.LIVEKIT_API_SECRET = process.env.WEBMEET_LIVEKIT_API_SECRET;
}

function safeParseJson(text) {
    try {
        return JSON.parse(String(text || ''));
    } catch {
        return null;
    }
}

function getJobMetadata(ctx) {
    return safeParseJson(ctx?.job?.metadata || ctx?.info?.job?.metadata || ctx?.info?.acceptArguments?.metadata || '') || {};
}

async function getDefaultLlmAgent() {
    const module = await import('achillesAgentLib/LLMAgents').catch(() => null);
    if (!module) return null;
    return (typeof module.getDefaultLLMAgent === 'function' && module.getDefaultLLMAgent())
        || (typeof module.registerDefaultLLMAgent === 'function' && module.registerDefaultLLMAgent())
        || null;
}

async function generateMentionReply({ meetingId, userMessage }) {
    const llmAgent = await getDefaultLlmAgent();
    if (!llmAgent || typeof llmAgent.executePrompt !== 'function') {
        throw new Error('WebMeet AI provider is not configured.');
    }
    const prompt = [
        `You are ${DISPLAY_NAME}, a self-hosted LiveKit participant in a WebMeet room.`,
        'Answer only the direct user request.',
        'Keep the response concise and factual.',
        'Do not invent meeting decisions, tasks, recordings, or participants.',
        '',
        `Meeting id: ${meetingId}`,
        `User request: ${userMessage}`,
        '',
        'Return plain text only.'
    ].join('\n');
    const raw = await llmAgent.executePrompt(prompt, { mode: 'fast', responseShape: 'text' });
    return String(raw || '').trim().replace(/^```(?:text)?\s*/i, '').replace(/\s*```$/g, '').trim();
}

async function persistAgentChat({ meetingId, authorId, message }) {
    const response = await fetch(`${API_BASE_URL}/api/meetings/${encodeURIComponent(meetingId)}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            authorId,
            authorName: DISPLAY_NAME,
            message
        })
    });
    const text = await response.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = null;
    }
    if (!response.ok) {
        throw new Error(parsed?.error || text || `Failed to persist agent chat: ${response.status}`);
    }
    return parsed?.message || {
        authorId,
        authorName: DISPLAY_NAME,
        message,
        kind: 'agent',
        createdAt: new Date().toISOString()
    };
}

async function publishWebMeetChat(room, meetingId, chatMessage) {
    const payload = new TextEncoder().encode(JSON.stringify({
        type: 'chat',
        meetingId,
        message: chatMessage
    }));
    const localParticipant = room?.localParticipant;
    if (typeof localParticipant?.publishData === 'function') {
        await localParticipant.publishData(payload, { reliable: true });
    }
}

async function handleChatPayload(ctx, metadata, payload, participant) {
    const data = safeParseJson(new TextDecoder().decode(payload));
    if (!data || data.type !== 'chat') return;
    const meetingId = String(metadata.meetingId || data.meetingId || '').trim();
    if (!meetingId) return;
    if (metadata.mode !== 'on_mention' && metadata.agentType !== 'assistant_on_mention') return;
    const message = String(data.message?.message || '').trim();
    if (!message || !message.includes(`@${DISPLAY_NAME}`)) return;
    const authorIdentity = String(participant?.identity || data.message?.authorId || '').trim();
    if (authorIdentity && authorIdentity === String(ctx.room?.localParticipant?.identity || '').trim()) return;

    let reply = '';
    try {
        reply = await generateMentionReply({ meetingId, userMessage: message });
    } catch (error) {
        reply = error instanceof Error ? error.message : String(error);
    }
    if (!reply) return;
    const authorId = String(ctx.room?.localParticipant?.identity || `${AGENT_NAME}:${meetingId}`).trim();
    const chatMessage = await persistAgentChat({ meetingId, authorId, message: reply });
    await publishWebMeetChat(ctx.room, meetingId, chatMessage);
}

export default livekitAgents.defineAgent({
    entry: async (ctx) => {
        const metadata = getJobMetadata(ctx);
        const room = ctx.room;
        room.on('dataReceived', (payload, participant) => {
            void handleChatPayload(ctx, metadata, payload, participant);
        });
        await ctx.connect();
        if (typeof room.localParticipant?.setAttributes === 'function') {
            await room.localParticipant.setAttributes({
                webmeetAgent: 'true',
                agentType: String(metadata.agentType || ''),
                mode: String(metadata.mode || '')
            });
        }
        await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            room.once('disconnected', finish);
            if (typeof ctx.addShutdownCallback === 'function') {
                ctx.addShutdownCallback(async () => finish());
            }
        });
    }
});

const Options = livekitAgents.ServerOptions || livekitAgents.WorkerOptions;
const serverOptions = new Options({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    logLevel: String(process.env.WEBMEET_LIVEKIT_AGENT_LOG_LEVEL || 'info'),
    requestFunc: async (request) => {
        const metadata = safeParseJson(request?.job?.metadata || '') || {};
        const identity = `${AGENT_NAME}-${request.id}`;
        await request.accept(DISPLAY_NAME, identity, JSON.stringify({
            webmeetAgent: 'true',
            meetingId: String(metadata.meetingId || ''),
            agentType: String(metadata.agentType || ''),
            mode: String(metadata.mode || '')
        }), {
            webmeetAgent: 'true',
            webmeetAgentName: AGENT_NAME,
            webmeetMeetingId: String(metadata.meetingId || ''),
            webmeetAgentType: String(metadata.agentType || ''),
            webmeetAgentMode: String(metadata.mode || '')
        });
    }
});

if (process.argv.length < 3) {
    process.argv.push('start');
}

livekitAgents.cli.runApp(serverOptions);
