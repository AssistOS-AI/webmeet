import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

import {
    appendMeetingChat,
    appendGuestMeetingChat,
    appendGuestMeetingTranscript,
    appendMeetingTranscript,
    attachMeetingAgent,
    createMeeting,
    createStoreContext,
    createWorkspace,
    getMeeting,
    getGuestMeetingDetails,
    joinMeeting,
    joinGuestMeeting,
    leaveGuestMeeting,
    leaveMeeting,
    pingGuestMeetingPresence,
    pingMeetingPresence,
    listMeetingAgents,
    listMeetingArtifacts,
    listMeetingChat,
    listMeetingEvents,
    listMeetings,
    listMeetingTranscript,
    listWorkspaces,
    startMeetingRecording,
    stopMeetingRecording
} from '../lib/webmeetStore.mjs';

const PORT = Number.parseInt(process.env.WEBMEET_API_PORT || '8791', 10);
const SSE_KEEPALIVE_MS = 15_000;

function json(res, status, payload) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    res.end(`${JSON.stringify(payload)}\n`);
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
}

function getActor(body) {
    const actor = body?.actor;
    return actor && typeof actor === 'object' ? actor : null;
}

function sseWrite(res, event) {
    const id = String(event?.id || '').trim();
    const type = String(event?.type || 'message').trim() || 'message';
    if (id) res.write(`id: ${id}\n`);
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function getLastEventId(req, url) {
    const header = String(req.headers?.['last-event-id'] || '').trim();
    if (header) return header;
    return String(url.searchParams.get('lastEventId') || '').trim();
}

function assertGuestEventAccess(context, meetingId, url) {
    const guestToken = String(url.searchParams.get('guestToken') || '').trim();
    const participantId = String(url.searchParams.get('participantId') || '').trim();
    if (!guestToken || !participantId) {
        throw new Error('Guest event access requires guest token and participant.');
    }
    getGuestMeetingDetails(context, { meetingId, guestToken, participantId });
}

function sendMeetingEvents(req, res, context, meetingId, { afterId = '', url = null } = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    if (url?.searchParams?.has('guestToken')) {
        assertGuestEventAccess(context, targetMeetingId, url);
    } else {
        getMeeting(context, targetMeetingId);
    }
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*'
    });
    res.write(': connected\n\n');
    let lastEventId = String(afterId || '').trim();
    const sendBacklog = () => {
        for (const event of listMeetingEvents(context, targetMeetingId, { afterId: lastEventId })) {
            sseWrite(res, event);
            lastEventId = String(event?.id || lastEventId).trim();
        }
    };
    sendBacklog();

    const eventsDir = path.join(context.eventsDir, targetMeetingId);
    fs.mkdirSync(eventsDir, { recursive: true });
    const watcher = fs.watch(eventsDir, () => {
        try {
            sendBacklog();
        } catch (_) {
            // Keep the stream open; the next event can still be delivered.
        }
    });
    const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
    }, SSE_KEEPALIVE_MS);
    const cleanup = () => {
        clearInterval(keepalive);
        try { watcher.close(); } catch (_) {}
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
}

function matchRoute(method, pathname) {
    const routes = [
        ['healthz', 'GET', /^\/healthz$/],
        ['workspaces.list', 'GET', /^\/api\/workspaces$/],
        ['workspaces.create', 'POST', /^\/api\/workspaces$/],
        ['meetings.list', 'GET', /^\/api\/workspaces\/([^/]+)\/meetings$/],
        ['meetings.create', 'POST', /^\/api\/workspaces\/([^/]+)\/meetings$/],
        ['meetings.get', 'GET', /^\/api\/meetings\/([^/]+)$/],
        ['meetings.events', 'GET', /^\/api\/meetings\/([^/]+)\/events$/],
        ['meetings.join', 'POST', /^\/api\/meetings\/([^/]+)\/join$/],
        ['meetings.join.guest', 'POST', /^\/api\/meetings\/([^/]+)\/join-guest$/],
        ['meetings.guest.state', 'POST', /^\/api\/meetings\/([^/]+)\/guest-state$/],
        ['meetings.guest.leave', 'POST', /^\/api\/meetings\/([^/]+)\/guest-leave$/],
        ['meetings.guest.presence', 'POST', /^\/api\/meetings\/([^/]+)\/guest-presence$/],
        ['chat.guest.send', 'POST', /^\/api\/meetings\/([^/]+)\/guest-chat$/],
        ['transcript.guest.append', 'POST', /^\/api\/meetings\/([^/]+)\/guest-transcript$/],
        ['meetings.leave', 'POST', /^\/api\/meetings\/([^/]+)\/leave$/],
        ['meetings.presence', 'POST', /^\/api\/meetings\/([^/]+)\/presence$/],
        ['chat.list', 'GET', /^\/api\/meetings\/([^/]+)\/chat$/],
        ['chat.send', 'POST', /^\/api\/meetings\/([^/]+)\/chat$/],
        ['agents.list', 'GET', /^\/api\/meetings\/([^/]+)\/agents$/],
        ['agents.attach', 'POST', /^\/api\/meetings\/([^/]+)\/agents$/],
        ['recording.start', 'POST', /^\/api\/meetings\/([^/]+)\/recording\/start$/],
        ['recording.stop', 'POST', /^\/api\/meetings\/([^/]+)\/recording\/stop$/],
        ['transcript.list', 'GET', /^\/api\/meetings\/([^/]+)\/transcript$/],
        ['transcript.append', 'POST', /^\/api\/meetings\/([^/]+)\/transcript$/],
        ['artifacts.list', 'GET', /^\/api\/meetings\/([^/]+)\/artifacts$/],
        ['tasks.list', 'GET', /^\/api\/meetings\/([^/]+)\/tasks$/],
        ['decisions.list', 'GET', /^\/api\/meetings\/([^/]+)\/decisions$/]
    ];
    for (const [name, allowedMethod, pattern] of routes) {
        const match = pathname.match(pattern);
        if (method === allowedMethod && match) {
            return { name, pattern, params: match.slice(1) };
        }
    }
    return null;
}

async function handler(req, res) {
    if (!req.url) {
        json(res, 400, { error: 'Missing request URL.' });
        return;
    }
    if (req.method === 'OPTIONS') {
        json(res, 204, {});
        return;
    }
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const route = matchRoute(req.method || 'GET', url.pathname);
    if (!route) {
        json(res, 404, { error: 'Not found.' });
        return;
    }
    const context = createStoreContext();
    try {
        if (route.name === 'healthz') {
            json(res, 200, { ok: true });
            return;
        }
        if (route.name === 'workspaces.list') {
            json(res, 200, { workspaces: listWorkspaces(context) });
            return;
        }
        if (route.name === 'workspaces.create') {
            const body = await readBody(req);
            json(res, 200, createWorkspace(context, { name: String(body.name || '').trim() }));
            return;
        }
        if (route.name === 'meetings.list' || route.name === 'meetings.create') {
            const [workspaceId] = route.params;
            if (route.name === 'meetings.list') {
                json(res, 200, { meetings: listMeetings(context, workspaceId) });
                return;
            }
            const body = await readBody(req);
            json(res, 201, createMeeting(context, {
                workspaceId,
                title: String(body.title || '').trim(),
                roomType: String(body.roomType || 'team').trim(),
                authInfo: getActor(body)
            }));
            return;
        }
        if (route.name === 'meetings.get') {
            json(res, 200, getMeeting(context, route.params[0]));
            return;
        }
        if (route.name === 'meetings.events') {
            sendMeetingEvents(req, res, context, route.params[0], {
                afterId: getLastEventId(req, url),
                url
            });
            return;
        }
        if (route.name === 'meetings.join') {
            const body = await readBody(req);
            json(res, 200, joinMeeting(context, {
                meetingId: route.params[0],
                displayName: String(body.displayName || '').trim(),
                participantId: String(body.participantId || '').trim(),
                authInfo: getActor(body)
            }));
            return;
        }
        if (route.name === 'meetings.join.guest') {
            const body = await readBody(req);
            json(res, 200, joinGuestMeeting(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                displayName: String(body.displayName || '').trim(),
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'meetings.guest.state') {
            const body = await readBody(req);
            json(res, 200, getGuestMeetingDetails(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'meetings.guest.leave') {
            const body = await readBody(req);
            json(res, 200, leaveGuestMeeting(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'meetings.guest.presence') {
            const body = await readBody(req);
            json(res, 200, pingGuestMeetingPresence(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'meetings.leave') {
            const body = await readBody(req);
            json(res, 200, leaveMeeting(context, {
                meetingId: route.params[0],
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'meetings.presence') {
            const body = await readBody(req);
            json(res, 200, pingMeetingPresence(context, {
                meetingId: route.params[0],
                participantId: String(body.participantId || '').trim()
            }));
            return;
        }
        if (route.name === 'chat.list' || route.name === 'chat.send') {
            const meetingId = route.params[0];
            if (route.name === 'chat.list') {
                json(res, 200, { messages: listMeetingChat(context, meetingId) });
                return;
            }
            const body = await readBody(req);
            json(res, 201, await appendMeetingChat(context, {
                meetingId,
                authorId: String(body.authorId || '').trim(),
                authorName: String(body.authorName || '').trim(),
                message: String(body.message || '').trim()
            }));
            return;
        }
        if (route.name === 'chat.guest.send') {
            const body = await readBody(req);
            json(res, 201, await appendGuestMeetingChat(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                participantId: String(body.participantId || '').trim(),
                message: String(body.message || '').trim()
            }));
            return;
        }
        if (route.name === 'agents.list' || route.name === 'agents.attach') {
            const meetingId = route.params[0];
            if (route.name === 'agents.list') {
                json(res, 200, { agents: listMeetingAgents(context, meetingId) });
                return;
            }
            const body = await readBody(req);
            json(res, 201, await attachMeetingAgent(context, {
                meetingId,
                agentType: String(body.agentType || '').trim(),
                mode: String(body.mode || '').trim(),
                authInfo: getActor(body)
            }));
            return;
        }
        if (route.name === 'recording.start') {
            json(res, 200, await startMeetingRecording(context, route.params[0]));
            return;
        }
        if (route.name === 'recording.stop') {
            json(res, 200, await stopMeetingRecording(context, route.params[0]));
            return;
        }
        if (route.name === 'transcript.list') {
            json(res, 200, { transcript: listMeetingTranscript(context, route.params[0]) });
            return;
        }
        if (route.name === 'transcript.append') {
            const body = await readBody(req);
            json(res, 201, await appendMeetingTranscript(context, {
                meetingId: route.params[0],
                speakerId: String(body.speakerId || '').trim(),
                speakerName: String(body.speakerName || '').trim(),
                text: String(body.text || '').trim()
            }));
            return;
        }
        if (route.name === 'transcript.guest.append') {
            const body = await readBody(req);
            json(res, 201, await appendGuestMeetingTranscript(context, {
                meetingId: route.params[0],
                guestToken: String(body.guestToken || '').trim(),
                participantId: String(body.participantId || '').trim(),
                text: String(body.text || '').trim()
            }));
            return;
        }
        if (route.name === 'artifacts.list') {
            json(res, 200, listMeetingArtifacts(context, route.params[0]));
            return;
        }
        if (route.name === 'tasks.list') {
            const payload = listMeetingArtifacts(context, route.params[0]);
            json(res, 200, { tasks: payload.tasks });
            return;
        }
        if (route.name === 'decisions.list') {
            const payload = listMeetingArtifacts(context, route.params[0]);
            json(res, 200, { decisions: payload.decisions });
            return;
        }
        json(res, 404, { error: 'Unhandled route.' });
    } catch (error) {
        const guestRoute = route.name === 'meetings.join.guest'
            || route.name.startsWith('meetings.guest.')
            || route.name.startsWith('chat.guest.')
            || route.name.startsWith('transcript.guest.');
        if (guestRoute) {
            json(res, 403, { error: 'Guest access denied.' });
            return;
        }
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
}

const server = http.createServer((req, res) => {
    void handler(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`webmeet-api listening on ${PORT}\n`);
});
