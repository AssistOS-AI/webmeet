import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePrivateLiveKitCall } from '../../lib/runtime/edgeRuntime.mjs';

test('RoomService calls use the private convention route and bind assertion bytes', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'webmeet-edge-runtime-'));
  const lib = path.join(runtime, 'lib');
  await mkdir(lib);
  await writeFile(path.join(lib, 'edgeTopology.mjs'), 'export function readEdgeTopology() { return {}; }\n');
  await writeFile(path.join(lib, 'agentAssertion.mjs'), `
    export function signPrivateRouterAssertion(input) {
      globalThis.__livekitAssertionInput = input;
      return JSON.stringify({ method: input.method, path: input.path, body: Buffer.from(input.body).toString('hex') });
    }
  `);
  try {
    const body = Buffer.from('room-service-body');
    const resolved = await resolvePrivateLiveKitCall({
      methodName: 'DeleteRoom',
      body,
      env: {
        PLOINKY_AGENT_LIB_DIR: runtime,
        PLOINKY_INTERNAL_ROUTER_URL: 'http://127.0.0.1:8081',
      },
    });
    const expectedPath = '/base-agent-additional-server/liveKitServerAgent/7880/twirp/livekit.RoomService/DeleteRoom';
    assert.equal(resolved.url.href, `http://127.0.0.1:8081${expectedPath}`);
    assert.equal(resolved.requestPath, expectedPath);
    assert.deepEqual(JSON.parse(resolved.assertion), {
      method: 'POST',
      path: expectedPath,
      body: body.toString('hex'),
    });
    assert.equal(globalThis.__livekitAssertionInput.body.equals(body), true);
  } finally {
    delete globalThis.__livekitAssertionInput;
    await rm(runtime, { recursive: true, force: true });
  }
});

test('RoomService rejects path-shaping method names before resolving or signing', async () => {
  await assert.rejects(
    resolvePrivateLiveKitCall({ methodName: '../DeleteRoom', body: Buffer.alloc(0), env: {} }),
    /method is invalid/i,
  );
});
