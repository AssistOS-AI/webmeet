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
    const { handleWebMeetToolCall } = await import('../../tools/webmeet_tool.mjs');
    const previousName = process.env.TOOL_NAME;
    process.env.TOOL_NAME = 'webmeet_room_get';
    t.after(() => {
        if (previousName === undefined) delete process.env.TOOL_NAME;
        else process.env.TOOL_NAME = previousName;
    });
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
