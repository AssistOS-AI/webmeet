import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS, directUserAuth, directUserEnvelope } from './verified-grant-fixture.mjs';

// Contract tests for running WebMeet tools in a warm Ploinky tool worker:
// the per-call handler, the spawn fallback bytes, call-scoped background work
// and the room-lock rules that keep a live worker pid from pinning a lock.

const toolsDir = fileURLToPath(new URL('../../tools/', import.meta.url));
const cliShell = path.join(toolsDir, 'webmeet_tool.sh');
const MASTER_KEY = '0123456789abcdef0123456789abcdef';
const UNCONFIRMED_RELEASE_KEY = Symbol.for('webmeet.unconfirmedRoomLockRelease');
const EXTERNAL_AGENT = Object.freeze({
    id: 'agent_external_1',
    agentType: 'external_agent',
    mode: 'listen',
    participantIdentity: 'agent-external-1',
    status: 'active',
    deletedAt: null
});

function capture() {
    const chunks = [];
    return {
        stdout: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
        text: () => Buffer.concat(chunks).toString('utf8')
    };
}

// A temporary WebMeet data root bound to process.env for the in-process store.
async function storeFixture(t) {
    const previous = {
        WEBMEET_DATA_DIR: process.env.WEBMEET_DATA_DIR,
        PLOINKY_WEBMEET_MASTER_KEY: process.env.PLOINKY_WEBMEET_MASTER_KEY
    };
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-tool-worker-')));
    process.env.WEBMEET_DATA_DIR = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = MASTER_KEY;
    t.after(async () => {
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        await fs.chmod(path.join(root, 'locks', 'rooms'), 0o700).catch(() => {});
        await fs.rm(root, { recursive: true, force: true });
    });
    const store = await import('../../lib/webmeetStore.mjs');
    const context = installEdgeJoinFixture(await store.createStoreContext(root));
    return { root, store, context };
}

async function createRoom(fixture, title = 'Worker room') {
    const admin = await directUserAuth(PRINCIPALS.admin);
    return await fixture.store.createMeeting(fixture.context, { title, roomType: 'team', authInfo: admin });
}

// Writes members and agents straight into the encrypted room payload, the way
// an earlier session would have left them.
async function seedRoomPayload(context, roomId, { members, agents }) {
    const { mutateRoom } = await import('../../lib/store/roomRecords.mjs');
    await mutateRoom(context, roomId, (_record, payload) => {
        if (members) payload.members = members;
        if (agents) payload.agents = [...(Array.isArray(payload.agents) ? payload.agents : []), ...agents];
    });
}

// Synchronous read, so no timer or I/O callback can run between the call
// resolving and the observation.
function readAgentsSync(context, roomId) {
    const record = JSON.parse(fsSync.readFileSync(path.join(context.meetingsDir, `${roomId}.json`), 'utf8'));
    return context.decryptForTest(record).agents;
}

async function bindSyncDecrypt(context) {
    const { decryptRoomPayload } = await import('../../lib/store/roomRecords.mjs');
    context.decryptForTest = (record) => decryptRoomPayload(context, record);
    return context;
}

function cliEnv(root, toolName) {
    return {
        ...process.env,
        // A package.json above the checkout can make Node print a module-type
        // warning on stderr; the contract is the tool's own bytes.
        NODE_NO_WARNINGS: '1',
        WEBMEET_DATA_DIR: root,
        PLOINKY_WEBMEET_MASTER_KEY: MASTER_KEY,
        TOOL_NAME: toolName
    };
}

function runCli(root, toolName, envelope) {
    return spawnSync('/bin/sh', [cliShell], {
        cwd: root,
        env: cliEnv(root, toolName),
        input: JSON.stringify(envelope),
        timeout: 20_000
    });
}

test('W1: the spawn CLI keeps its exact result line and error bytes', async (t) => {
    const fixture = await storeFixture(t);
    await createRoom(fixture);
    const { dispatch } = await import('../../tools/webmeet_tool.mjs');
    const admin = await directUserAuth(PRINCIPALS.admin);
    const expected = `${JSON.stringify(await dispatch('webmeet_room_list', {}, fixture.context, admin))}\n`;

    const listed = runCli(fixture.root, 'webmeet_room_list', await directUserEnvelope({ ...PRINCIPALS.admin, tool: 'webmeet_room_list' }));
    assert.equal(listed.error, undefined);
    assert.equal(listed.status, 0, listed.stderr.toString());
    assert.equal(listed.stderr.toString(), '');
    assert.equal(listed.stdout.toString(), expected);
    assert.equal(JSON.parse(listed.stdout.toString()).canManageRooms, true);

    const unknown = runCli(fixture.root, 'x', await directUserEnvelope({ ...PRINCIPALS.admin, tool: 'x' }));
    assert.equal(unknown.status, 1);
    assert.equal(unknown.stdout.toString(), '');
    assert.equal(unknown.stderr.toString(), 'Unsupported TOOL_NAME "x".\n');

    const unnamed = runCli(fixture.root, '', await directUserEnvelope({ ...PRINCIPALS.admin }));
    assert.equal(unnamed.status, 1);
    assert.equal(unnamed.stderr.toString(), 'Unsupported TOOL_NAME "".\n');
});

test('W3: the handler takes the tool name per call and ignores the ambient TOOL_NAME', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const previousName = process.env.TOOL_NAME;
    process.env.TOOL_NAME = 'webmeet_room_get';
    t.after(() => {
        if (previousName === undefined) delete process.env.TOOL_NAME;
        else process.env.TOOL_NAME = previousName;
    });
    // A fresh module instance loaded while the ambient TOOL_NAME is set, as in
    // a worker process that inherited one.
    const { handleWebMeetToolCall } = await import('../../tools/webmeet_tool.mjs?ambient-tool-name');
    const first = capture();
    await handleWebMeetToolCall({
        toolName: 'webmeet_room_list',
        envelope: await directUserEnvelope({ ...PRINCIPALS.admin, tool: 'webmeet_room_list' }),
        stdout: first.stdout
    });
    assert.ok(Array.isArray(JSON.parse(first.text()).rooms));
    const second = capture();
    await handleWebMeetToolCall({
        toolName: 'webmeet_chat_list',
        envelope: await directUserEnvelope({ ...PRINCIPALS.admin, tool: 'webmeet_chat_list', input: { roomId: room.id } }),
        stdout: second.stdout
    });
    assert.deepEqual(Object.keys(JSON.parse(second.text())), ['messages']);
    await assert.rejects(
        handleWebMeetToolCall({ toolName: '', envelope: {}, stdout: capture().stdout }),
        /Unsupported TOOL_NAME ""/
    );
});

test('W7: background detach work finishes inside the call that started it', async (t) => {
    const fixture = await storeFixture(t);
    await bindSyncDecrypt(fixture.context);
    const { dispatch, handleWebMeetToolCall } = await import('../../tools/webmeet_tool.mjs');
    const admin = await directUserAuth(PRINCIPALS.admin);

    // Control: without the drain the detach is still pending when dispatch
    // resolves, so this test can tell a drained call from an undrained one.
    const control = await createRoom(fixture, 'Control room');
    await seedRoomPayload(fixture.context, control.id, { members: [], agents: [EXTERNAL_AGENT] });
    const controlContext = await bindSyncDecrypt(installEdgeJoinFixture(await fixture.store.createStoreContext(fixture.root)));
    controlContext.backgroundTasks = [];
    await dispatch('webmeet_agent_list', { roomId: control.id }, controlContext, admin);
    const pending = readAgentsSync(fixture.context, control.id).find((agent) => agent.id === EXTERNAL_AGENT.id);
    assert.equal(pending.status, 'active');
    assert.equal(controlContext.backgroundTasks.length > 0, true, 'the detach is registered with the call');
    await Promise.allSettled(controlContext.backgroundTasks);

    const room = await createRoom(fixture, 'Drained room');
    await seedRoomPayload(fixture.context, room.id, { members: [], agents: [EXTERNAL_AGENT] });
    const output = capture();
    await handleWebMeetToolCall({
        toolName: 'webmeet_agent_list',
        envelope: await directUserEnvelope({ ...PRINCIPALS.admin, tool: 'webmeet_agent_list', input: { roomId: room.id } }),
        stdout: output.stdout
    });
    const detached = readAgentsSync(fixture.context, room.id).find((agent) => agent.id === EXTERNAL_AGENT.id);
    assert.equal(detached.status, 'detached');
    assert.equal(detached.detachReason, 'no_human_participants');
    assert.ok(Array.isArray(JSON.parse(output.text()).agents));
});

test('RS2 (spawn): the CLI still detaches agents on the room-presence cleanup path', async (t) => {
    const fixture = await storeFixture(t);
    await bindSyncDecrypt(fixture.context);
    const room = await createRoom(fixture);
    await seedRoomPayload(fixture.context, room.id, { members: [], agents: [EXTERNAL_AGENT] });
    const result = runCli(fixture.root, 'webmeet_agent_list', await directUserEnvelope({
        ...PRINCIPALS.admin, tool: 'webmeet_agent_list', input: { roomId: room.id }
    }));
    assert.equal(result.status, 0, result.stderr.toString());
    const agent = readAgentsSync(fixture.context, room.id).find((entry) => entry.id === EXTERNAL_AGENT.id);
    assert.equal(agent.status, 'detached');
});

function lockPathFor(context, roomId) {
    return path.join(context.meetingLocksDir, `${roomId}.lock`);
}

test('W8: a lock left behind by a failed release in a live process is recovered after the stale TTL', async (t) => {
    const fixture = await storeFixture(t);
    const { withQueuedRoomLock } = await import('../../lib/store/roomLocks.mjs');
    const roomId = 'room_lock_leak';
    globalThis[UNCONFIRMED_RELEASE_KEY] = false;
    let leakedToken = '';
    await withQueuedRoomLock(fixture.context, roomId, async () => {
        leakedToken = JSON.parse(await fs.readFile(lockPathFor(fixture.context, roomId), 'utf8')).token;
        // The release cannot remove the file: this process keeps its pid alive.
        await fs.chmod(fixture.context.meetingLocksDir, 0o500);
    });
    await fs.chmod(fixture.context.meetingLocksDir, 0o700);
    const leaked = JSON.parse(await fs.readFile(lockPathFor(fixture.context, roomId), 'utf8'));
    assert.equal(leaked.token, leakedToken);
    assert.equal(leaked.pid, process.pid);
    const unconfirmed = globalThis[UNCONFIRMED_RELEASE_KEY];
    globalThis[UNCONFIRMED_RELEASE_KEY] = false;

    const started = Date.now();
    const value = await withQueuedRoomLock(fixture.context, roomId, async () => 'recovered', {
        staleTtlMs: 1_000,
        timeoutMs: 3_000
    });
    assert.equal(value, 'recovered');
    assert.ok(Date.now() - started < 2_000 + 500, 'recovered within the stale TTL plus one second');
    assert.equal(unconfirmed, true, 'a failed removal is reported as unconfirmed');
});

test('W8: an unreadable lock at release is unconfirmed, an externally removed one is not', async (t) => {
    const fixture = await storeFixture(t);
    const { withQueuedRoomLock } = await import('../../lib/store/roomLocks.mjs');
    globalThis[UNCONFIRMED_RELEASE_KEY] = false;
    await withQueuedRoomLock(fixture.context, 'room_lock_gone', async () => {
        await fs.rm(lockPathFor(fixture.context, 'room_lock_gone'));
    });
    assert.equal(globalThis[UNCONFIRMED_RELEASE_KEY], false, 'ENOENT at release needs no recycle');

    await withQueuedRoomLock(fixture.context, 'room_lock_garbled', async () => {
        await fs.writeFile(lockPathFor(fixture.context, 'room_lock_garbled'), '{not json');
    });
    assert.equal(globalThis[UNCONFIRMED_RELEASE_KEY], true);
    globalThis[UNCONFIRMED_RELEASE_KEY] = false;
    const value = await withQueuedRoomLock(fixture.context, 'room_lock_garbled', async () => 'ok', {
        staleTtlMs: 1_000,
        timeoutMs: 3_000
    });
    assert.equal(value, 'ok');
});

test('W8: a same-pid owner is alive only while its operation holds the token in this process', async (t) => {
    const fixture = await storeFixture(t);
    const roomLocks = await import('../../lib/store/roomLocks.mjs');
    const roomId = 'room_lock_owner';
    let heldOwner = null;
    await roomLocks.withQueuedRoomLock(fixture.context, roomId, async () => {
        heldOwner = JSON.parse(await fs.readFile(lockPathFor(fixture.context, roomId), 'utf8'));
        assert.equal(typeof heldOwner.instanceId, 'string');
        assert.equal(roomLocks.isLockOwnerProcessAlive(heldOwner), true, 'an in-flight operation still excludes others');
        assert.equal(
            roomLocks.isLockOwnerProcessAlive({ ...heldOwner, instanceId: 'another-process-instance' }),
            false,
            'a reused pid from another instance is dead'
        );
    });
    assert.equal(roomLocks.isLockOwnerProcessAlive(heldOwner), false, 'a released token no longer keeps the owner alive');
    const legacy = { ...heldOwner };
    delete legacy.instanceId;
    assert.equal(roomLocks.isLockOwnerProcessAlive(legacy), true, 'records without instanceId keep pid liveness');
    assert.equal(roomLocks.isLockOwnerProcessAlive({ ...heldOwner, hostname: 'elsewhere' }), false);
});

// ---------------------------------------------------------------------------
// Real Ploinky pool. PLOINKY_ROOT selects the checkout (default: the sibling
// ../ploinky); its Agent/server/toolWorkerPool.mjs spawns the workers.

const workerShell = path.join(toolsDir, 'webmeet_tool_worker.sh');
const fixtureWorker = fileURLToPath(new URL('./webmeet-tool-worker-fixture.mjs', import.meta.url));
const PLOINKY_ROOT = path.resolve(process.env.PLOINKY_ROOT || fileURLToPath(new URL('../../../../ploinky/', import.meta.url)));
const WORKER_TOOLS = [
    'webmeet_room_list', 'webmeet_room_get', 'webmeet_room_guest_get', 'webmeet_room_public_get',
    'webmeet_room_join', 'webmeet_room_join_guest', 'webmeet_room_leave', 'webmeet_presence_heartbeat',
    'webmeet_room_events_list', 'webmeet_chat_list', 'webmeet_participant_avatar_update', 'webmeet_resource_list'
];
const GUEST_ALLOWED_TOOLS = new Set([
    'webmeet_room_public_get', 'webmeet_room_join_guest', 'webmeet_room_guest_get', 'webmeet_chat_send_guest',
    'webmeet_room_leave', 'webmeet_presence_heartbeat', 'webmeet_participant_avatar_update'
]);
const GUEST = Object.freeze({ id: 'guest-visitor', roles: ['guest'], capabilities: [] });
const SCOPED_USER = Object.freeze({
    id: 'scoped-1',
    roles: ['user'],
    capabilities: ['explorer.access'],
    scope: ['webmeet:room:room_00000000-0000-4000-8000-0000000000ff']
});

async function loadPloinky(relative) {
    return await import(new URL(relative, `file://${PLOINKY_ROOT}/`).href);
}

async function realPool(t, root, options = {}) {
    const { ToolWorkerPool } = await loadPloinky('Agent/server/toolWorkerPool.mjs');
    const logs = [];
    const { env: extraEnv = {}, ...rest } = options;
    const pool = new ToolWorkerPool('webmeet', {
        command: workerShell,
        cwd: root,
        size: 1,
        env: {
            WEBMEET_DATA_DIR: root,
            PLOINKY_WEBMEET_MASTER_KEY: MASTER_KEY,
            NODE_NO_WARNINGS: '1',
            TOOL_NAME: 'ambient_wrong',
            ...extraEnv
        },
        idleTimeoutMs: 600_000,
        maxCallsPerWorker: 500,
        callTimeoutMs: 20_000,
        log: (line) => logs.push(line),
        ...rest
    });
    t.after(async () => {
        const outcome = await pool.shutdown({ timeoutMs: 5_000 });
        assert.equal(outcome.clean, true, 'WebMeet pool shutdown must be clean.');
    });
    return { pool, logs };
}

function fixturePool(t, root, options = {}) {
    return realPool(t, root, { command: process.execPath, args: [fixtureWorker], ...options });
}

// A pool call shaped like AgentServer's: the tool's TOOL_NAME in toolEnv and the
// verified envelope as the payload. The frame toolName is deliberately wrong.
function poolCall(pool, toolName, envelope) {
    return pool.call({ toolName: 'ignored_frame_name', toolEnv: { TOOL_NAME: toolName }, payload: envelope });
}

async function envelopeFor(principal, tool, input = {}) {
    return await directUserEnvelope({ ...principal, tool, input });
}

// room_get refreshes presence timestamps on every call, so two runs of the same
// call differ only in ISO timestamps; everything else must be byte-identical.
const ISO_TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function assertSameResult(actual, expected, label, { normalizeTimestamps = false } = {}) {
    const normalize = (text) => (normalizeTimestamps ? text.replace(ISO_TIMESTAMP, '<timestamp>') : text);
    assert.equal(actual.code, expected.status, `${label}: exit code\n${actual.stderr}`);
    assert.equal(normalize(actual.stdout), normalize(expected.stdout.toString()), `${label}: stdout`);
    assert.equal(actual.stderr, expected.stderr.toString(), `${label}: stderr`);
}

function unexpectedPoolLines(logs) {
    return logs.filter((line) => !/ timing | identity walk /.test(line));
}

test('W2: the worker returns the CLI bytes and exit codes for results and errors', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const { pool, logs } = await realPool(t, fixture.root);
    const cases = [
        ['webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list')],
        ['webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id, includeParticipants: false })],
        ['webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', {})],
        ['webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: 'room_00000000-0000-4000-8000-00000000dead', includeParticipants: false })],
        ['webmeet_unknown_tool', await envelopeFor(PRINCIPALS.admin, 'webmeet_unknown_tool')]
    ];
    for (const [toolName, envelope] of cases) {
        const expected = runCli(fixture.root, toolName, envelope);
        const actual = await poolCall(pool, toolName, envelope);
        assertSameResult(actual, expected, `${toolName} ${JSON.stringify(envelope.input)}`, { normalizeTimestamps: toolName === 'webmeet_room_get' });
    }
    const missing = await poolCall(pool, 'webmeet_room_get', cases[2][1]);
    assert.equal(missing.stderr, 'Missing required argument "roomId".\n');
    assert.equal(pool.stats().spawned, 1, 'every call used the same warm worker');
    assert.deepEqual(unexpectedPoolLines(logs), []);
});

test('W3: consecutive calls on one worker dispatch their own tool; toolEnv.TOOL_NAME wins over the frame name', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const { pool } = await realPool(t, fixture.root);
    const listed = await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list'));
    assert.equal(listed.code, 0, listed.stderr);
    assert.ok(Array.isArray(JSON.parse(listed.stdout).rooms));
    const chat = await poolCall(pool, 'webmeet_chat_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_chat_list', { roomId: room.id }));
    assert.equal(chat.code, 0, chat.stderr);
    assert.deepEqual(Object.keys(JSON.parse(chat.stdout)), ['messages']);
    // Without a configured TOOL_NAME the frame name is used, never the ambient one.
    const byFrame = await pool.call({ toolName: 'webmeet_room_list', toolEnv: {}, payload: await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list') });
    assert.equal(byFrame.code, 0, byFrame.stderr);
    assert.ok(Array.isArray(JSON.parse(byFrame.stdout).rooms));
    const unnamed = await pool.call({ toolName: '', toolEnv: {}, payload: await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list') });
    assert.equal(unnamed.code, 1);
    assert.equal(unnamed.stderr, 'Unsupported TOOL_NAME "".\n');
    assert.equal(pool.stats().spawned, 1);
});

test('W4/W6: identities, admin rights and invocation tokens never cross calls on one worker', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const { pool, logs } = await realPool(t, fixture.root);
    const adminList = await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list');
    const adminToken = adminList.metadata.invocationToken;
    const results = [];

    const a = await poolCall(pool, 'webmeet_room_list', adminList);
    results.push(a);
    assert.equal(a.code, 0, a.stderr);
    assert.equal(JSON.parse(a.stdout).canManageRooms, true);
    assert.deepEqual(JSON.parse(a.stdout).rooms.map((entry) => entry.id), [room.id]);

    const g = await poolCall(pool, 'webmeet_room_list', await envelopeFor(GUEST, 'webmeet_room_list'));
    results.push(g);
    assert.equal(g.code, 1);
    assert.equal(g.stderr, 'Access denied: guest invocation cannot call "webmeet_room_list".\n');

    const b = await poolCall(pool, 'webmeet_room_get', await envelopeFor(SCOPED_USER, 'webmeet_room_get', { roomId: room.id, includeParticipants: false }));
    results.push(b);
    assert.equal(b.code, 1);
    assert.equal(b.stderr, 'Meeting not found.\n');

    // W6: admin rights follow each call's own grant on the same worker.
    const user = await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.explorerUser, 'webmeet_room_list'));
    const admin = await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list'));
    const noGrant = await poolCall(pool, 'webmeet_room_list', { tool: 'webmeet_room_list', input: {} });
    results.push(user, admin, noGrant);
    assert.equal(JSON.parse(user.stdout).canManageRooms, false);
    assert.equal(JSON.parse(admin.stdout).canManageRooms, true);
    assert.equal(noGrant.code, 1, 'a call without a grant must not inherit the previous admin');

    assert.equal(pool.stats().spawned, 1, 'every call used the same warm worker');
    const everything = results.map((result) => result.stdout + result.stderr).join('\n') + logs.join('\n');
    assert.equal(everything.includes(adminToken), false, 'the admin invocation token must not appear in outputs or pool logs');
    assert.equal(b.stdout.includes('owner-1') || b.stderr.includes('owner-1'), false);
});

test('W5: every tool outside the guest allowlist rejects a guest grant in worker mode as in spawn mode', async (t) => {
    const fixture = await storeFixture(t);
    const descriptor = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const { pool } = await realPool(t, fixture.root);
    const denied = descriptor.tools.map((tool) => tool.name).filter((name) => !GUEST_ALLOWED_TOOLS.has(name));
    assert.equal(denied.length, descriptor.tools.length - 7);
    for (const name of denied) {
        const result = await poolCall(pool, name, await envelopeFor(GUEST, name, { roomId: 'room_00000000-0000-4000-8000-000000000001' }));
        assert.equal(result.code, 1, name);
        assert.equal(result.stdout, '', name);
        assert.equal(result.stderr, `Access denied: guest invocation cannot call "${name}".\n`, name);
    }
    for (const name of ['webmeet_room_list', 'webmeet_room_rename', 'webmeet_room_events_list']) {
        const envelope = await envelopeFor(GUEST, name, { roomId: 'room_00000000-0000-4000-8000-000000000001' });
        assertSameResult(await poolCall(pool, name, envelope), runCli(fixture.root, name, envelope), name);
    }
    assert.equal(pool.stats().spawned, 1);
});

test('W7 (worker): deferred detach work is finished when the result frame arrives, with no stray output', async (t) => {
    const fixture = await storeFixture(t);
    await bindSyncDecrypt(fixture.context);
    const presence = await createRoom(fixture, 'Presence cleanup room');
    const realtime = await createRoom(fixture, 'Realtime roster room');
    for (const room of [presence, realtime]) {
        await seedRoomPayload(fixture.context, room.id, { members: [], agents: [EXTERNAL_AGENT] });
    }
    const { pool, logs } = await fixturePool(t, fixture.root);
    const agentList = await poolCall(pool, 'webmeet_agent_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_agent_list', { roomId: presence.id }));
    assert.equal(agentList.code, 0, agentList.stderr);
    assert.equal(readAgentsSync(fixture.context, presence.id).find((agent) => agent.id === EXTERNAL_AGENT.id).status, 'detached');
    const roomGet = await poolCall(pool, 'webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: realtime.id }));
    assert.equal(roomGet.code, 0, roomGet.stderr);
    assert.equal(readAgentsSync(fixture.context, realtime.id).find((agent) => agent.id === EXTERNAL_AGENT.id).status, 'detached');
    // The next call on the same worker is unaffected.
    const next = await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list'));
    assert.equal(next.code, 0, next.stderr);
    assert.equal(pool.stats().spawned, 1);
    assert.deepEqual(unexpectedPoolLines(logs), []);
});

test('W8 (worker): an unconfirmed lock release recycles the worker and another worker recovers the lock', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const faultFile = path.join(fixture.root, 'fault-pid.txt');
    const livekitFile = path.join(fixture.root, 'livekit.json');
    await fs.writeFile(livekitFile, '[]');
    const { pool, logs } = await fixturePool(t, fixture.root, {
        size: 2,
        env: {
            WEBMEET_WORKER_FIXTURE_FAULT_FILE: faultFile,
            WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE: livekitFile,
            WEBMEET_LOCK_STALE_TTL_MS: '1000',
            WEBMEET_LOCK_TIMEOUT_MS: '5000'
        }
    });
    const call = (tool, input = {}) => poolCall(pool, tool, { tool, input });
    const warm = await Promise.all([call('fixture_hold', { ms: 600 }), call('fixture_hold', { ms: 600 })]);
    assert.equal(new Set(warm.map((result) => result.stdout)).size, 2, 'two distinct warm workers');
    // Keep one worker busy so the next calls land on the other, which leaks its lock.
    const holding = call('fixture_hold', { ms: 900 });
    const leaker = await call('fixture_pid');
    await fs.writeFile(faultFile, leaker.stdout);
    const leaked = await poolCall(pool, 'webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id }));
    assert.equal(leaked.code, 0, leaked.stderr);
    const lockFile = path.join(fixture.context.meetingLocksDir, `${room.id}.lock`);
    assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid, Number(leaker.stdout), 'the lock file was left behind');
    const holder = await holding;
    assert.notEqual(holder.stdout, leaker.stdout);
    assert.ok(pool.stats().recycled >= 1, `the worker with the unconfirmed release was recycled\n${logs.join('\n')}`);

    const started = Date.now();
    const contender = await poolCall(pool, 'webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id }));
    const elapsed = Date.now() - started;
    assert.equal(contender.code, 0, contender.stderr);
    assert.ok(elapsed < 1_000 + 1_000 + 1_500, `the contender waited ${elapsed} ms (stale TTL 1000 ms)`);
    assert.equal(fsSync.existsSync(lockFile), false);
});

test('W9: external writes are visible to the next call and a code change retires the worker', async (t) => {
    const fixture = await storeFixture(t);
    const codeDir = await fs.mkdtemp(path.join(fixture.root, 'code-'));
    await fs.writeFile(path.join(codeDir, 'tool.mjs'), 'export const version = 1;\n');
    const past = new Date(Date.now() - 60_000);
    await fs.utimes(path.join(codeDir, 'tool.mjs'), past, past);
    const { createCodeIdentity } = await loadPloinky('Agent/server/toolCodeIdentity.mjs');
    const { pool } = await fixturePool(t, fixture.root, { codeIdentity: createCodeIdentity({ roots: [codeDir], settleMs: 0 }) });
    const list = async () => JSON.parse((await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list'))).stdout).rooms;
    assert.deepEqual(await list(), []);
    const created = await createRoom(fixture, 'Written outside the worker');
    assert.deepEqual((await list()).map((entry) => entry.id), [created.id]);
    const firstPid = (await poolCall(pool, 'fixture_pid', {})).stdout;
    assert.equal(pool.stats().spawned, 1);

    await fs.writeFile(path.join(codeDir, 'tool.mjs'), 'export const version = 2;\n');
    await fs.utimes(path.join(codeDir, 'tool.mjs'), past, new Date(Date.now() - 30_000));
    const secondPid = (await poolCall(pool, 'fixture_pid', {})).stdout;
    assert.notEqual(secondPid, firstPid, 'the worker started under the old code was retired');
    assert.equal(pool.stats().spawned, 2);
});

test('W10: a worker killed mid-call fails that call only; the replacement serves and the dead lock is recovered', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const { pool } = await fixturePool(t, fixture.root, { env: { WEBMEET_LOCK_STALE_TTL_MS: '1000' } });
    const firstPid = Number((await poolCall(pool, 'fixture_pid', {})).stdout);
    const busy = poolCall(pool, 'fixture_hold_lock', { tool: 'fixture_hold_lock', input: { roomId: room.id, ms: 10_000 } });
    const lockFile = path.join(fixture.context.meetingLocksDir, `${room.id}.lock`);
    for (let attempt = 0; attempt < 100 && !fsSync.existsSync(lockFile); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(JSON.parse(await fs.readFile(lockFile, 'utf8')).pid, firstPid);
    process.kill(firstPid, 'SIGKILL');
    const failed = await busy;
    assert.equal(failed.code, 1);
    assert.equal(failed.stdout, '');

    const next = await poolCall(pool, 'webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id }));
    assert.equal(next.code, 0, next.stderr);
    assert.notEqual(Number((await poolCall(pool, 'fixture_pid', {})).stdout), firstPid);
    assert.equal(fsSync.existsSync(lockFile), false, 'no lock with a dead owner remains');
    assert.equal(pool.stats().crashes >= 1, true);
});

test('W11: parallel writes on one room through four workers neither lose updates nor time out', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const now = new Date().toISOString();
    const members = Array.from({ length: 20 }, (_, index) => ({ id: `participant-${index}`, displayName: `P${index}`, joinedAt: now, lastSeenAt: now }));
    await seedRoomPayload(fixture.context, room.id, { members });
    const livekitFile = path.join(fixture.root, 'livekit.json');
    await fs.writeFile(livekitFile, JSON.stringify(members.map((member) => ({ identity: member.id, name: member.displayName, kind: 'STANDARD', attributes: {} }))));
    const { pool } = await fixturePool(t, fixture.root, { size: 4, env: { WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE: livekitFile } });
    const calls = [];
    for (let index = 0; index < 20; index += 1) {
        const principal = { id: `user-${index}`, roles: ['user'], capabilities: ['explorer.access'] };
        calls.push(poolCall(pool, 'webmeet_participant_avatar_update', await envelopeFor(principal, 'webmeet_participant_avatar_update', {
            roomId: room.id,
            participantId: `participant-${index}`,
            avatar: { enabled: true, fallbackLetter: 'P', config: { generated: true, emotion: 'happy', seed: `seed-${index}` } }
        })));
    }
    for (let index = 0; index < 5; index += 1) {
        calls.push(poolCall(pool, 'webmeet_room_get', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId: room.id })));
    }
    const results = await Promise.all(calls);
    for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /Timed out acquiring meeting lock/);
    }
    const { decryptRoomPayload, loadRoomRecord } = await import('../../lib/store/roomRecords.mjs');
    const payload = decryptRoomPayload(fixture.context, await loadRoomRecord(fixture.context, room.id));
    // Each update binds its participant to the caller inside the room lock; a
    // lost read-modify-write would leave a participant unbound.
    assert.deepEqual(
        payload.members.map((member) => [member.id, member.userId]).sort(),
        members.map((member, index) => [member.id, `user-${index}`]).sort()
    );
    assert.ok(pool.stats().spawned >= 2 && pool.stats().spawned <= 4);
});

test('W12: the pool declaration, the worker tool set and the spawn fallback are pinned', async () => {
    const descriptor = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    assert.deepEqual(descriptor.toolWorkers, {
        webmeet: { command: 'tools/webmeet_tool_worker.sh', cwd: 'workspace', size: 4 }
    });
    const workers = descriptor.tools.filter((tool) => tool.worker !== undefined).map((tool) => tool.name).sort();
    assert.deepEqual(workers, [...WORKER_TOOLS].sort());
    for (const tool of descriptor.tools) {
        assert.equal(tool.worker, WORKER_TOOLS.includes(tool.name) ? 'webmeet' : undefined, tool.name);
        assert.equal(tool.command, 'tools/webmeet_tool.sh', tool.name);
        assert.equal(tool.cwd, descriptor.toolWorkers.webmeet.cwd, tool.name);
        assert.deepEqual(tool.env, { TOOL_NAME: tool.name }, tool.name);
        assert.equal(tool.async, undefined, tool.name);
    }
    assert.equal(descriptor.tools.find((tool) => tool.name === 'webmeet_room_rename').worker, undefined);
    for (const file of ['webmeet_tool_worker.sh', 'webmeet_tool_worker.mjs', 'webmeet_tool.sh', 'webmeet_tool.mjs']) {
        assert.notEqual((await fs.stat(path.join(toolsDir, file))).mode & 0o111, 0, `${file} must be executable`);
    }
    const manifest = JSON.parse(await fs.readFile(new URL('../../manifest.json', import.meta.url), 'utf8'));
    for (const profile of ['default', 'dev']) {
        const entries = manifest.profiles[profile].env.filter((entry) => String(entry?.name || '').startsWith('PLOINKY_TOOL_WORKER'));
        assert.deepEqual(entries, [
            { name: 'PLOINKY_TOOL_WORKERS', value: '1' },
            { name: 'PLOINKY_TOOL_WORKER_TIMINGS', required: false }
        ], profile);
    }
    const startScript = await fs.readFile(new URL('../../scripts/startAgent.sh', import.meta.url), 'utf8');
    assert.match(startScript, /chmod \+x [^\n]*\/code\/tools\/webmeet_tool_worker\.sh [^\n]*\/code\/tools\/webmeet_tool_worker\.mjs/);
});

test('the worker refuses a missing or relative shared runtime module path', async () => {
    const { serveWebMeetToolWorker } = await import('../../tools/webmeet_tool_worker.mjs');
    for (const workerModulePath of ['', 'relative.mjs']) {
        await assert.rejects(serveWebMeetToolWorker({ workerModulePath }), /absolute PLOINKY_TOOL_WORKER_MODULE/);
    }
});

test('probes: boundary, orphan, idempotency and malformed envelopes match spawn mode and keep the worker usable', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const deleted = await createRoom(fixture, 'Deleted room');
    const admin = await directUserAuth(PRINCIPALS.admin);
    await fixture.store.deleteMeeting(fixture.context, { meetingId: deleted.id, confirm: true, authInfo: admin }).catch(async () => {
        await fs.rm(path.join(fixture.context.meetingsDir, `${deleted.id}.json`));
    });
    const { pool } = await realPool(t, fixture.root);
    const roomGet = async (roomId) => await envelopeFor(PRINCIPALS.admin, 'webmeet_room_get', { roomId, includeParticipants: false });
    const parity = [
        ['webmeet_room_get', await roomGet('')],
        ['webmeet_room_get', await roomGet('r'.repeat(10_000))],
        ['webmeet_room_get', await roomGet('room_ü')],
        ['webmeet_room_get', await roomGet(deleted.id)],
        ['webmeet_chat_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_chat_list', { roomId: deleted.id })],
        ['webmeet_room_join', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_join', { roomId: deleted.id, participantId: 'p-orphan' })],
        ['webmeet_room_list', { tool: 'webmeet_room_list', input: {}, metadata: { invocation: 'not-an-object' } }]
    ];
    for (const [toolName, envelope] of parity) {
        const expected = runCli(fixture.root, toolName, envelope);
        const actual = await poolCall(pool, toolName, envelope);
        assertSameResult(actual, expected, `${toolName} ${JSON.stringify(envelope.input).slice(0, 60)}`);
        assert.equal(actual.code, 1, `${toolName} must fail`);
    }
    // The tool layer trusts metadata that AgentServer has verified, in both
    // modes; a forged grant is rejected by AgentServer before dispatch.
    const forgedEnvelope = { tool: 'webmeet_room_list', input: {}, metadata: { invocation: { sub: 'user:forged', actor: { kind: 'user', id: 'user:forged', roles: ['admin'] } } } };
    const forged = await poolCall(pool, 'webmeet_room_list', forgedEnvelope);
    assertSameResult(forged, runCli(fixture.root, 'webmeet_room_list', forgedEnvelope), 'forged grant');
    const listed = await poolCall(pool, 'webmeet_room_list', await envelopeFor(PRINCIPALS.admin, 'webmeet_room_list'));
    assert.equal(listed.code, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).rooms.map((entry) => entry.id), [room.id]);
    assert.equal(pool.stats().spawned, 1, 'the worker stayed alive through every failure');
    assert.deepEqual(await fs.readdir(fixture.context.meetingLocksDir), [], 'no lock file is left behind');
});

test('probes: replayed leave and join through a worker behave as in spawn mode', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const livekitFile = path.join(fixture.root, 'livekit.json');
    await fs.writeFile(livekitFile, '[]');
    const { pool } = await fixturePool(t, fixture.root, { env: { WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE: livekitFile } });
    const okJson = (result) => {
        assert.equal(result.code, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    const call = async (principal, tool, input) => await poolCall(pool, tool, await envelopeFor(principal, tool, input));
    const joinInput = { roomId: room.id, participantId: 'p-replay', displayName: 'Replay' };
    const leaveInput = { roomId: room.id, participantId: 'p-replay' };
    okJson(await call(PRINCIPALS.explorerUser, 'webmeet_room_join', joinInput));
    assert.equal(okJson(await call(PRINCIPALS.explorerUser, 'webmeet_room_leave', leaveInput)).removed, true);
    // A user's replayed leave no longer finds its participant: the same denial as a spawned process.
    const replayEnvelope = await envelopeFor(PRINCIPALS.explorerUser, 'webmeet_room_leave', leaveInput);
    const replayed = await poolCall(pool, 'webmeet_room_leave', replayEnvelope);
    assertSameResult(replayed, runCli(fixture.root, 'webmeet_room_leave', replayEnvelope), 'replayed user leave');
    assert.equal(replayed.stderr, 'Access denied: cannot act as another participant.\n');
    // An administrator's replayed leave is a no-op.
    assert.equal(okJson(await call(PRINCIPALS.admin, 'webmeet_room_leave', leaveInput)).removed, false);
    const joinedAgain = okJson(await call(PRINCIPALS.explorerUser, 'webmeet_room_join', joinInput));
    const joinedTwice = okJson(await call(PRINCIPALS.explorerUser, 'webmeet_room_join', joinInput));
    assert.equal(joinedAgain.participantIdentity, 'p-replay');
    assert.equal(joinedTwice.participantIdentity, 'p-replay');
    const { decryptRoomPayload, loadRoomRecord } = await import('../../lib/store/roomRecords.mjs');
    const payload = decryptRoomPayload(fixture.context, await loadRoomRecord(fixture.context, room.id));
    assert.deepEqual(payload.members.map((member) => member.id), ['p-replay'], 'no duplicate member');
    assert.equal(pool.stats().spawned, 1);
});

test('probes: a leave racing another user\'s roster read on two workers never re-adds the leaver (50 rounds)', async (t) => {
    const fixture = await storeFixture(t);
    const room = await createRoom(fixture);
    const livekitFile = path.join(fixture.root, 'livekit.json');
    const { pool } = await fixturePool(t, fixture.root, { size: 2, env: { WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE: livekitFile } });
    const leaver = PRINCIPALS.explorerUser;
    const stayer = { id: 'member-2', roles: ['user'], capabilities: ['explorer.access'] };
    const live = (ids) => fs.writeFile(livekitFile, JSON.stringify(ids.map((identity) => ({ identity, name: identity, kind: 'STANDARD', attributes: {} }))));
    const call = async (principal, tool, input) => {
        const result = await poolCall(pool, tool, await envelopeFor(principal, tool, input));
        assert.equal(result.code, 0, `${tool}: ${result.stderr}`);
        return result;
    };
    const { decryptRoomPayload, loadRoomRecord } = await import('../../lib/store/roomRecords.mjs');
    await live(['p-stays', 'p-leaves']);
    await call(stayer, 'webmeet_room_join', { roomId: room.id, participantId: 'p-stays', displayName: 'Stays' });
    for (let round = 0; round < 50; round += 1) {
        await live(['p-stays', 'p-leaves']);
        await call(leaver, 'webmeet_room_join', { roomId: room.id, participantId: 'p-leaves', displayName: 'Leaves' });
        // The leaver has disconnected from LiveKit, as the browser does before room_leave.
        await live(['p-stays']);
        await Promise.all([
            call(leaver, 'webmeet_room_leave', { roomId: room.id, participantId: 'p-leaves' }),
            call(stayer, 'webmeet_room_get', { roomId: room.id })
        ]);
        const payload = decryptRoomPayload(fixture.context, await loadRoomRecord(fixture.context, room.id));
        assert.deepEqual(payload.members.map((member) => member.id), ['p-stays'], `round ${round}`);
    }
    assert.deepEqual(await fs.readdir(fixture.context.meetingLocksDir), []);
});
