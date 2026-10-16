import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    listMeetingChat
} from '../../lib/webmeetStore.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import { installScriptaFolderFixture } from './edge-join-fixture.mjs';

const ENV_KEYS = [
    'PLOINKY_WEBMEET_MASTER_KEY',
    'PLOINKY_ROUTER_URL',
    'WEBMEET_DATA_DIR'
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

function startStubRouter() {
    const calls = [];
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            calls.push({
                method: req.method,
                url: req.url,
                body: Buffer.concat(chunks).toString('utf8')
            });
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unexpected relay call' }));
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port, calls });
        });
    });
}

async function makeContext() {
    const authInfo = { user: { id: 'local:admin', username: 'admin', name: 'Admin', roles: ['admin'] } };
    const context = installScriptaFolderFixture(await createStoreContext(tempRoot));
    context.envelope = { metadata: { invocationToken: 'caller-token' } };
    const meeting = await createMeeting(context, {
        name: 'Research room',
        authInfo
    });
    return { context, authInfo, meeting };
}

beforeEach(() => {
    restoreEnv();
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-no-agent-tag-'));
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    process.env.WEBMEET_DATA_DIR = path.join(tempRoot, 'data');
});

afterEach(() => {
    restoreEnv();
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

describe('WebMeet no-agent-tag chat', () => {
    it('persists @open-interpreter as ordinary meeting chat without relay dispatch', async () => {
        const { server, port, calls } = await startStubRouter();
        try {
            process.env.PLOINKY_ROUTER_URL = `http://127.0.0.1:${port}`;
            const { context, authInfo, meeting } = await makeContext();
            const result = await dispatch('webmeet_chat_send', {
                roomId: meeting.id,
                message: '@open-interpreter Give status.'
            }, context, authInfo);
            const messages = await listMeetingChat(context, meeting.id, authInfo);
            assert.equal(result.researchTask, null);
            assert.equal(calls.length, 0);
            assert.equal(messages.length, 1);
            assert.equal(messages[0].authorId, 'local:admin');
            assert.equal(messages[0].message, '@open-interpreter Give status.');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('persists unknown @word mentions as ordinary chat', async () => {
        const { context, authInfo, meeting } = await makeContext();
        const result = await dispatch('webmeet_chat_send', {
            roomId: meeting.id,
            message: '@teammate please review this'
        }, context, authInfo);
        const messages = await listMeetingChat(context, meeting.id, authInfo);
        assert.equal(result.researchTask, null);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].message, '@teammate please review this');
    });

    it('rejects unauthenticated chat sends instead of trusting caller author fields', async () => {
        const { context, meeting } = await makeContext();
        await assert.rejects(
            dispatch('webmeet_chat_send', {
                roomId: meeting.id,
                authorId: 'research:open-interpreter',
                authorName: 'Research Relay',
                message: 'not allowed'
            }, context, null),
            /authentication is required/i
        );
    });
});
