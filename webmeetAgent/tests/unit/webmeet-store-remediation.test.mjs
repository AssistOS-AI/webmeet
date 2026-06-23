import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const MASTER_KEY = crypto.randomBytes(32).toString('base64');
const ADMIN_AUTH = { id: 'local:admin', username: 'admin', roles: ['admin'] };
const execFileAsync = promisify(execFile);

let tmpRoot;
let context;

async function freshContext() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-test-'));
    const ploinkyDir = path.join(dir, '.ploinky');
    await fs.mkdir(ploinkyDir, { recursive: true });

    process.env.PLOINKY_WEBMEET_MASTER_KEY = MASTER_KEY;
    process.env.PLOINKY_WORKSPACE_ROOT = dir;

    const { createStoreContext } = await import('../../lib/webmeetStore.mjs');
    return { dir, context: await createStoreContext(dir) };
}

async function createTestMeeting(ctx, title = 'Test Room', roomType = 'team') {
    const { createMeeting } = await import('../../lib/webmeetStore.mjs');
    return createMeeting(ctx, { title, roomType, authInfo: ADMIN_AUTH });
}

async function createGuestMeetingWithParticipant(ctx, title = 'Guest Room') {
    const { createMeeting, joinGuestMeeting } = await import('../../lib/webmeetStore.mjs');
    const meeting = await createMeeting(ctx, { title, roomType: 'guest', authInfo: ADMIN_AUTH });
    const joinResult = await joinGuestMeeting(ctx, {
        meetingId: meeting.id,
        displayName: 'Test Guest',
    });
    return { meeting, joinResult, participantId: joinResult.participantIdentity };
}

before(async () => {
    const result = await freshContext();
    tmpRoot = result.dir;
    context = result.context;
});

after(async () => {
    if (tmpRoot) {
        await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
});

describe('concurrent meeting mutations (lock + in-process queue)', () => {
    test('concurrent chat appends do not lose data', async () => {
        const { appendMeetingChat, listMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context);

        const chatCount = 10;
        const promises = [];

        for (let i = 0; i < chatCount; i++) {
            promises.push(appendMeetingChat(context, {
                meetingId: meeting.id,
                authorId: `user-${i}`,
                authorName: `User ${i}`,
                message: `chat-${i}`,
                skipAccessCheck: true,
            }));
        }

        await Promise.all(promises);

        const chats = await listMeetingChat(context, meeting.id, ADMIN_AUTH);

        assert.equal(chats.length, chatCount, `Expected ${chatCount} chat messages, got ${chats.length}`);

        const chatMessages = chats.map((c) => c.message).sort();
        const expectedChats = Array.from({ length: chatCount }, (_, i) => `chat-${i}`).sort();
        assert.deepEqual(chatMessages, expectedChats);
    });

    test('concurrent LiveKit-backed meeting reads serialize correctly', async () => {
        const { joinMeeting, getMeeting } = await import('../../lib/webmeetStore.mjs');
        const liveContext = {
            ...context,
            listLiveKitParticipants: async () => [{
                identity: 'ping-participant',
                name: 'Pinger',
                attributes: {}
            }]
        };
        const meeting = await createTestMeeting(context);

        await joinMeeting(liveContext, {
            meetingId: meeting.id,
            displayName: 'Pinger',
            participantId: 'ping-participant',
            authInfo: ADMIN_AUTH,
        });

        const reads = Array.from({ length: 5 }, () =>
            getMeeting(liveContext, meeting.id, ADMIN_AUTH, { includeParticipants: true })
        );
        await Promise.all(reads);

        const meetingDetails = await getMeeting(liveContext, meeting.id, ADMIN_AUTH, { includeParticipants: false });
        assert.ok(meetingDetails, 'Meeting should still be readable after concurrent LiveKit-backed reads');
    });

    test('child process chat appends serialize through the filesystem lock', async () => {
        const { listMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'Cross Process Room');
        const storeUrl = pathToFileURL(path.resolve(import.meta.dirname, '../../lib/webmeetStore.mjs')).href;
        const childCode = `
            const { createStoreContext, appendMeetingChat } = await import(${JSON.stringify(storeUrl)});
            const [workspaceRoot, meetingId, index] = process.argv.slice(1);
            const context = await createStoreContext(workspaceRoot);
            await appendMeetingChat(context, {
                meetingId,
                authorId: \`child-\${index}\`,
                authorName: \`Child \${index}\`,
                message: \`child-message-\${index}\`,
                skipAccessCheck: true
            });
        `;
        const childCount = 8;
        await Promise.all(Array.from({ length: childCount }, (_, index) => execFileAsync(
            process.execPath,
            ['--input-type=module', '-e', childCode, tmpRoot, meeting.id, String(index)],
            {
                env: {
                    ...process.env,
                    PLOINKY_WORKSPACE_ROOT: tmpRoot,
                    PLOINKY_WEBMEET_MASTER_KEY: MASTER_KEY,
                    WEBMEET_LOCK_TIMEOUT_MS: '5000',
                    WEBMEET_LOCK_STALE_TTL_MS: '5000',
                },
                maxBuffer: 1024 * 1024,
            }
        )));

        const chats = await listMeetingChat(context, meeting.id, ADMIN_AUTH);
        const messages = chats.map((entry) => entry.message).filter((message) => message.startsWith('child-message-')).sort();
        assert.deepEqual(
            messages,
            Array.from({ length: childCount }, (_, index) => `child-message-${index}`).sort()
        );
    });
});

describe('event staging — events recorded only after successful payload save', () => {
    test('meeting creation records room and workspace events', async () => {
        const { listMeetingEvents, listWorkspaceEvents } = await import('../../lib/webmeetStore.mjs');
        const { WEBMEET_EVENT_TYPES, parseWebMeetEvent } = await import('../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js');
        const meeting = await createTestMeeting(context, 'Created Event Room');

        const meetingEvents = await listMeetingEvents(context, meeting.id);
        const workspaceEvents = await listWorkspaceEvents(context, 'rooms');
        const createdMeetingEvents = meetingEvents.map(parseWebMeetEvent).filter((event) => (
            event.type === WEBMEET_EVENT_TYPES.MEETING_CREATED
            && event.payload.meetingId === meeting.id
        ));
        const createdWorkspaceEvents = workspaceEvents.map(parseWebMeetEvent).filter((event) => (
            event.type === WEBMEET_EVENT_TYPES.MEETING_CREATED
            && event.payload.meetingId === meeting.id
        ));

        assert.equal(createdMeetingEvents.length, 1);
        assert.equal(createdWorkspaceEvents.length, 1);
        assert.equal(createdWorkspaceEvents[0].room, 'rooms');
        assert.equal(createdWorkspaceEvents[0].payload.workspaceId, 'rooms');
    });

    test('chat message event appears in event log after mutation completes', async () => {
        const { appendMeetingChat, listMeetingEvents } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context);

        await appendMeetingChat(context, {
            meetingId: meeting.id,
            authorId: 'user-evt',
            authorName: 'Event User',
            message: 'event-test-message',
            skipAccessCheck: true,
        });

        const events = await listMeetingEvents(context, meeting.id);
        const chatEvents = events.filter((e) => String(e).includes('chat.message.created'));
        assert.ok(chatEvents.length >= 1, 'At least one chat.message.created event should exist in the event log');
    });

});

describe('guest-state response narrowing', () => {
    test('getGuestMeetingDetails returns only meeting, participants, and chat', async () => {
        const { getGuestMeetingDetails, appendMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const { meeting, participantId } = await createGuestMeetingWithParticipant(context);

        await appendMeetingChat(context, {
            meetingId: meeting.id,
            authorId: participantId,
            authorName: 'Test Guest',
            message: 'hello from guest',
            skipAccessCheck: true,
        });

        const details = await getGuestMeetingDetails(context, {
            meetingId: meeting.id,
            participantId,
        });

        const allowedKeys = new Set(['meeting', 'participants', 'chat']);
        const actualKeys = new Set(Object.keys(details));
        assert.deepEqual(actualKeys, allowedKeys, `Guest details should only contain ${[...allowedKeys].join(', ')}, got: ${[...actualKeys].join(', ')}`);

        assert.ok(details.meeting, 'meeting should be present');
        assert.ok(Array.isArray(details.participants), 'participants should be an array');
        assert.ok(Array.isArray(details.chat), 'chat should be an array');

        assert.equal(details.resources, undefined, 'resources must not be exposed to guests through room details');
        assert.equal(details.agents, undefined, 'agents must not be exposed to guests');
    });
});

describe('MCP chat schema — author is derived from invocation context', () => {
    test('mcp-config.json does not accept caller-supplied author fields for webmeet_chat_send', async () => {
        const configPath = path.resolve(import.meta.dirname, '../../mcp-config.json');
        const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
        const chatSend = config.tools.find((t) => t.name === 'webmeet_chat_send');
        assert.ok(chatSend, 'webmeet_chat_send tool should exist in mcp-config.json');

        assert.equal(chatSend.inputSchema.authorId, undefined, 'authorId should not be accepted from the client');
        assert.equal(chatSend.inputSchema.authorName, undefined, 'authorName should not be accepted from the client');
        assert.equal(chatSend.inputSchema.roomId?.optional, false, 'roomId should remain required');
        assert.equal(chatSend.inputSchema.message?.optional, false, 'message should remain required');
    });
});

describe('guest chat derives author from participant record, not caller-supplied fields', () => {
    test('appendGuestMeetingChat uses participant displayName, not caller-supplied author', async () => {
        const { appendGuestMeetingChat, listMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const { meeting, participantId } = await createGuestMeetingWithParticipant(context, 'Guest Author Room');

        await appendGuestMeetingChat(context, {
            meetingId: meeting.id,
            participantId,
            message: 'guest says hello',
        });

        const chats = await listMeetingChat(context, meeting.id, ADMIN_AUTH);
        const guestChat = chats.find((c) => c.message === 'guest says hello');
        assert.ok(guestChat, 'Guest chat message should be present');
        assert.equal(guestChat.authorId, participantId, 'authorId should be the participant identity, not caller-supplied');
        assert.equal(guestChat.authorName, 'Test Guest', 'authorName should come from the participant record displayName');
    });
});

describe('filesystem lock mechanics', () => {
    const previousLockTimeoutMs = process.env.WEBMEET_LOCK_TIMEOUT_MS;
    const previousLockStaleTtlMs = process.env.WEBMEET_LOCK_STALE_TTL_MS;

    after(() => {
        if (previousLockTimeoutMs === undefined) {
            delete process.env.WEBMEET_LOCK_TIMEOUT_MS;
        } else {
            process.env.WEBMEET_LOCK_TIMEOUT_MS = previousLockTimeoutMs;
        }
        if (previousLockStaleTtlMs === undefined) {
            delete process.env.WEBMEET_LOCK_STALE_TTL_MS;
        } else {
            process.env.WEBMEET_LOCK_STALE_TTL_MS = previousLockStaleTtlMs;
        }
    });

    test('lock file is created and cleaned up after mutation', async () => {
        const { appendMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context);

        await appendMeetingChat(context, {
            meetingId: meeting.id,
            authorId: 'lock-user',
            authorName: 'Lock User',
            message: 'lock-test',
            skipAccessCheck: true,
        });

        const lockPath = path.join(context.meetingLocksDir, `${meeting.id}.lock`);
        let lockExists = false;
        try {
            await fs.access(lockPath);
            lockExists = true;
        } catch {
            lockExists = false;
        }
        assert.equal(lockExists, false, 'Lock file should be cleaned up after mutation completes');
    });

    test('fresh ownerless locks are not removed as stale', async () => {
        const { appendMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'Fresh Lock Room');
        const lockPath = path.join(context.meetingLocksDir, `${meeting.id}.lock`);
        await fs.writeFile(lockPath, '');
        process.env.WEBMEET_LOCK_TIMEOUT_MS = '150';
        process.env.WEBMEET_LOCK_STALE_TTL_MS = '2000';

        await assert.rejects(
            appendMeetingChat(context, {
                meetingId: meeting.id,
                authorId: 'blocked',
                authorName: 'Blocked',
                message: 'should-time-out',
                skipAccessCheck: true,
            }),
            /Timed out acquiring meeting lock/
        );

        await fs.access(lockPath);
        assert.equal(await fs.readFile(lockPath, 'utf8'), '');
        await fs.rm(lockPath, { force: true });
    });

    test('stale ownerless locks are cleaned up after the stale TTL', async () => {
        const { appendMeetingChat, listMeetingChat } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'Stale Lock Room');
        const lockPath = path.join(context.meetingLocksDir, `${meeting.id}.lock`);
        await fs.writeFile(lockPath, '');
        const oldTime = new Date(Date.now() - 5_000);
        await fs.utimes(lockPath, oldTime, oldTime);
        process.env.WEBMEET_LOCK_TIMEOUT_MS = '1000';
        process.env.WEBMEET_LOCK_STALE_TTL_MS = '1000';

        await appendMeetingChat(context, {
            meetingId: meeting.id,
            authorId: 'stale-user',
            authorName: 'Stale User',
            message: 'stale-lock-recovered',
            skipAccessCheck: true,
        });

        const chats = await listMeetingChat(context, meeting.id, ADMIN_AUTH);
        assert.ok(chats.some((entry) => entry.message === 'stale-lock-recovered'));
    });

    test('LiveKit participant reconciliation waits for the meeting lock', async () => {
        const { getMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'Locked Reconcile Room');
        const lockPath = path.join(context.meetingLocksDir, `${meeting.id}.lock`);
        await fs.writeFile(lockPath, JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            meetingId: meeting.id,
            token: 'external-owner'
        }));
        context.listLiveKitParticipants = async () => ([{
            identity: 'livekit-participant',
            name: 'LiveKit Participant',
            attributes: {}
        }]);
        process.env.WEBMEET_LOCK_TIMEOUT_MS = '150';
        process.env.WEBMEET_LOCK_STALE_TTL_MS = '2000';

        await assert.rejects(
            getMeeting(context, meeting.id, ADMIN_AUTH),
            /Timed out acquiring meeting lock/
        );

        await fs.access(lockPath);
        delete context.listLiveKitParticipants;
        await fs.rm(lockPath, { force: true });
    });

    test('archiveMeeting waits for the meeting lock', async () => {
        const { archiveMeeting } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'Locked Archive Room');
        const lockPath = path.join(context.meetingLocksDir, `${meeting.id}.lock`);
        await fs.writeFile(lockPath, JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAt: new Date().toISOString(),
            meetingId: meeting.id,
            token: 'external-delete-owner'
        }));
        process.env.WEBMEET_LOCK_TIMEOUT_MS = '150';
        process.env.WEBMEET_LOCK_STALE_TTL_MS = '2000';

        await assert.rejects(
            archiveMeeting(context, meeting.id, ADMIN_AUTH),
            /Timed out acquiring meeting lock/
        );

        await fs.access(path.join(context.meetingsDir, `${meeting.id}.json`));
        await fs.rm(lockPath, { force: true });
    });

    test('archiveMeeting persists WebMeet archive when LiveKit close is denied', async () => {
        const { archiveMeeting, listMeetings } = await import('../../lib/webmeetStore.mjs');
        const meeting = await createTestMeeting(context, 'LiveKit Denied Archive Room');
        const liveContext = {
            ...context,
            closeLiveKitRoom: async () => {
                throw new Error('LiveKit room API failed: permissions denied');
            }
        };

        const result = await archiveMeeting(liveContext, meeting.id, ADMIN_AUTH);
        const archived = (await listMeetings(context, '', ADMIN_AUTH))
            .find((entry) => entry.id === meeting.id);

        assert.equal(result.ok, true);
        assert.equal(result.meeting.status, 'archived');
        assert.equal(archived.status, 'archived');
        assert.ok(archived.archivedAt);
    });
});

describe('removed WebMeet public server', () => {
    test('public proxy file is not present', async () => {
        const proxyPath = path.resolve(import.meta.dirname, '../../server', `webmeet-public-${'proxy'}.mjs`);
        await assert.rejects(fs.access(proxyPath), /ENOENT/);
    });
});

describe('manifest secret compatibility', () => {
    test('PLOINKY_WEBMEET_MASTER_KEY uses generatedSecret', async () => {
        const manifestPath = path.resolve(import.meta.dirname, '../../manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        const entries = [];
        const visit = (value) => {
            if (Array.isArray(value)) {
                for (const entry of value) visit(entry);
                return;
            }
            if (!value || typeof value !== 'object') return;
            if (value.name === 'PLOINKY_WEBMEET_MASTER_KEY') {
                entries.push(value);
            }
            for (const entry of Object.values(value)) visit(entry);
        };
        visit(manifest);

        assert.ok(entries.length >= 1, 'manifest should declare PLOINKY_WEBMEET_MASTER_KEY');
        for (const entry of entries) {
            assert.equal(entry.generatedSecret, true);
            assert.equal(entry.derive, undefined);
            assert.equal(entry.sharedGeneratedSecret, undefined);
        }
    });

    test('LiveKit room close token includes DeleteRoom grant', async () => {
        const { closeLiveKitRoom } = await import('../../lib/runtime/livekitRuntime.mjs');
        const originalFetch = globalThis.fetch;
        let authorization = '';
        globalThis.fetch = async (_url, options = {}) => {
            authorization = String(options?.headers?.Authorization || '');
            return {
                ok: true,
                text: async () => '{}'
            };
        };
        try {
            await closeLiveKitRoom({
                livekitApiUrl: 'http://livekit.test',
                livekitApiKey: 'test-key',
                livekitApiSecret: 'test-secret',
                agentName: 'WebMeetAgent'
            }, 'room-a', { strict: true });
        } finally {
            globalThis.fetch = originalFetch;
        }

        const token = authorization.replace(/^Bearer\s+/i, '');
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
        assert.equal(payload.video.roomAdmin, true);
        assert.equal(payload.video.roomCreate, true);
        assert.equal(payload.video.room, 'room-a');
    });
});
