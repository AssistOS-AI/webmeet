import http from 'node:http';
import { URL } from 'node:url';

import {
    appendMeetingChat,
    appendMeetingTranscript,
    attachMeetingAgent,
    closeMeeting,
    createMeeting,
    createStoreContext,
    createWorkspace,
    getMeeting,
    joinMeeting,
    listMeetingAgents,
    listMeetingArtifacts,
    listMeetingChat,
    listMeetings,
    listMeetingTranscript,
    listWorkspaces,
    startMeetingRecording,
    stopMeetingRecording
} from '../lib/webmeetStore.mjs';

const PORT = Number.parseInt(process.env.WEBMEET_API_PORT || '8791', 10);

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

function matchRoute(method, pathname) {
    const routes = [
        ['healthz', 'GET', /^\/healthz$/],
        ['workspaces.list', 'GET', /^\/api\/workspaces$/],
        ['workspaces.create', 'POST', /^\/api\/workspaces$/],
        ['meetings.list', 'GET', /^\/api\/workspaces\/([^/]+)\/meetings$/],
        ['meetings.create', 'POST', /^\/api\/workspaces\/([^/]+)\/meetings$/],
        ['meetings.get', 'GET', /^\/api\/meetings\/([^/]+)$/],
        ['meetings.join', 'POST', /^\/api\/meetings\/([^/]+)\/join$/],
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
            json(res, 201, createMeeting(context, { workspaceId, title: String(body.title || '').trim() }));
            return;
        }
        if (route.name === 'meetings.get') {
            json(res, 200, getMeeting(context, route.params[0]));
            return;
        }
        if (route.name === 'meetings.join') {
            const body = await readBody(req);
            json(res, 200, joinMeeting(context, {
                meetingId: route.params[0],
                displayName: String(body.displayName || '').trim(),
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
        if (route.name === 'agents.list' || route.name === 'agents.attach') {
            const meetingId = route.params[0];
            if (route.name === 'agents.list') {
                json(res, 200, { agents: listMeetingAgents(context, meetingId) });
                return;
            }
            const body = await readBody(req);
            json(res, 201, attachMeetingAgent(context, {
                meetingId,
                agentType: String(body.agentType || '').trim(),
                mode: String(body.mode || '').trim()
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
        json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
}

const server = http.createServer((req, res) => {
    void handler(req, res);
});

server.listen(PORT, '0.0.0.0', () => {
    process.stdout.write(`webmeet-api listening on ${PORT}\n`);
});
