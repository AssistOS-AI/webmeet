import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    createWorkspace,
    listMeetingChat
} from '../../lib/webmeetStore.mjs';
import {
    dispatch,
    parseTagRelayMention,
    resolveTagRelayConfig
} from '../../tools/webmeet_tool.mjs';

const ENV_KEYS = [
    'PLOINKY_WEBMEET_MASTER_KEY',
    'PLOINKY_ROUTER_URL',
    'WEBMEET_DATA_DIR',
    'WEBMEET_RESEARCH_TAGS',
    'WEBMEET_TAG_RELAY_AGENT',
    'WEBMEET_TAG_RELAY_SUBMIT_TOOL',
    'WEBMEET_TAG_RELAY_LIST_TOOL',
    'WEBMEET_TAG_RELAY_TAGS',
    'WEBMEET_TAG_RELAY_TIMEOUT_MS'
];

const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let tempRoot = '';

function restoreEnv() {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
}

function configureRelayEnv(port) {
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${port}`;
    process.env.WEBMEET_DATA_DIR = path.join(tempRoot, 'data');
    process.env.WEBMEET_RESEARCH_TAGS = '1';
    process.env.WEBMEET_TAG_RELAY_AGENT = 'researchRelay';
    process.env.WEBMEET_TAG_RELAY_SUBMIT_TOOL = 'research_task_submit';
    process.env.WEBMEET_TAG_RELAY_LIST_TOOL = 'research_relay_list_backends';
    process.env.WEBMEET_TAG_RELAY_TAGS = 'open-interpreter';
    process.env.WEBMEET_TAG_RELAY_TIMEOUT_MS = '450000';
}

function startStubRouter(handler) {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            let body = {};
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
            } catch {
                body = {};
            }
            const call = {
                method: req.method,
                url: req.url,
                jwt: req.headers['x-ploinky-caller-jwt'] || '',
                body
            };
            calls.push(call);
            const response = handler(call);
            if (Object.hasOwn(response, 'rawBody')) {
                res.writeHead(response.status || 200, { 'content-type': response.contentType || 'text/plain' });
                res.end(String(response.rawBody || ''));
                return;
            }
            res.writeHead(response.status || 200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(response.body || {}));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, calls });
        });
    });
}

function makeContext() {
    const authInfo = { user: { id: 'local:admin', username: 'admin', name: 'Admin', roles: ['admin'] } };
    const context = createStoreContext(tempRoot);
    context.envelope = { metadata: { invocationToken: 'caller-token' } };
    const workspace = createWorkspace(context);
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Research room',
        authInfo
    });
    return { context, authInfo, meeting };
}

beforeEach(() => {
    restoreEnv();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-tag-relay-'));
});

afterEach(() => {
    restoreEnv();
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('WebMeet tagged research chat', () => {
    it('uses Copilot-style static tag-relay configuration', () => {
        const config = resolveTagRelayConfig({
            WEBMEET_RESEARCH_TAGS: '1',
            WEBMEET_TAG_RELAY_AGENT: 'researchRelay',
            WEBMEET_TAG_RELAY_SUBMIT_TOOL: 'research_task_submit',
            WEBMEET_TAG_RELAY_LIST_TOOL: 'research_relay_list_backends',
            WEBMEET_TAG_RELAY_TAGS: 'open-interpreter',
            WEBMEET_TAG_RELAY_TIMEOUT_MS: '450000'
        });
        assert.equal(config.enabled, true);
        assert.equal(config.agent, 'researchRelay');
        assert.equal(config.submitTool, 'research_task_submit');
        assert.equal(config.listTool, 'research_relay_list_backends');
        assert.equal(config.timeoutMs, 450000);
        assert.deepEqual([...config.tags], ['open-interpreter']);
    });

    it('parses configured mention prompts like Copilot WebChat tag relay', () => {
        assert.deepEqual(parseTagRelayMention('please ask @open-interpreter now'), {
            tag: 'open-interpreter',
            prompt: 'please ask now'
        });
    });

    it('delegates configured static tags without a catalog preflight', async () => {
        const { server, port, calls } = await startStubRouter((call) => ({
            body: {
                jsonrpc: '2.0',
                id: call.body.id,
                result: {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({ backend: 'open-interpreter', final_answer: 'Research result.' })
                    }]
                }
            }
        }));
        try {
            configureRelayEnv(port);
            const { context, authInfo, meeting } = makeContext();
            const result = await dispatch('webmeet_chat_send', {
                meetingId: meeting.id,
                message: '@open-interpreter Give status.'
            }, context, authInfo);
            const messages = listMeetingChat(context, meeting.id);
            assert.equal(result.researchTask.final_answer, 'Research result.');
            assert.equal(calls.length, 1);
            assert.match(calls[0].url, /\/mcps\/researchRelay\/mcp$/);
            assert.equal(calls[0].jwt, 'caller-token');
            assert.equal(calls[0].body.params.name, 'research_task_submit');
            assert.equal(calls[0].body.params.arguments.backend, 'open-interpreter');
            assert.equal(calls[0].body.params.arguments.prompt, 'Give status.');
            assert.equal(messages.length, 2);
            assert.equal(messages[0].authorId, 'local:admin');
            assert.equal(messages[1].authorId, 'research:open-interpreter');
            assert.equal(messages[1].message, 'Research result.');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('reports a clear deployment error when the research relay route is missing', async () => {
        const { server, port, calls } = await startStubRouter(() => ({
            status: 404,
            rawBody: 'API Route not found'
        }));
        try {
            configureRelayEnv(port);
            const { context, authInfo, meeting } = makeContext();
            const result = await dispatch('webmeet_chat_send', {
                meetingId: meeting.id,
                message: '@open-interpreter Give status.'
            }, context, authInfo);
            const messages = listMeetingChat(context, meeting.id);
            assert.equal(calls.length, 1);
            assert.equal(result.researchTask.ok, false);
            assert.match(result.researchTask.error, /Research relay agent "researchRelay" is not routed by Ploinky/);
            assert.match(result.researchTask.error, /Enable copilot-agents\/research-agents/);
            assert.equal(messages.length, 2);
            assert.equal(messages[1].authorName, 'Research Relay');
            assert.match(messages[1].message, /Research relay agent "researchRelay" is not routed by Ploinky/);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('leaves unknown mentions as ordinary chat', async () => {
        const { server, port, calls } = await startStubRouter(() => ({
            body: { result: { content: [] } }
        }));
        try {
            configureRelayEnv(port);
            const { context, authInfo, meeting } = makeContext();
            const result = await dispatch('webmeet_chat_send', {
                meetingId: meeting.id,
                message: '@teammate please review this'
            }, context, authInfo);
            const messages = listMeetingChat(context, meeting.id);
            assert.equal(result.researchTask, null);
            assert.equal(calls.length, 0);
            assert.equal(messages.length, 1);
            assert.equal(messages[0].message, '@teammate please review this');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });
});
