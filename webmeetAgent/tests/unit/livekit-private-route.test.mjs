import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePrivateLiveKitCall } from '../../lib/runtime/edgeRuntime.mjs';

test('RoomService calls resolve only the private livekit-api service and bind assertion bytes', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'webmeet-edge-runtime-'));
  const lib = path.join(runtime, 'lib');
  await mkdir(lib);
  await writeFile(path.join(lib, 'edgeTopology.mjs'), `
    export function readEdgeTopology() { return {}; }
    export function resolveEdgeService(input) {
      globalThis.__livekitResolvedServiceInput = input;
      return { service: { externalPrefix: '/services/livekit-api/' } };
    }
  `);
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
        PLOINKY_EDGE_TOPOLOGY_FILE: '/root/.ploinky/edge-topology-v2.json',
        PLOINKY_INTERNAL_ROUTER_URL: 'http://127.0.0.1:8081',
      },
    });
    assert.equal(resolved.url.href, 'http://127.0.0.1:8081/services/livekit-api/DeleteRoom');
    assert.equal(resolved.requestPath, '/services/livekit-api/DeleteRoom');
    assert.deepEqual(globalThis.__livekitResolvedServiceInput, {
      routeKey: 'liveKitServerAgent',
      slug: 'livekit-api',
      requireActive: true,
      file: '/root/.ploinky/edge-topology-v2.json',
    });
    assert.deepEqual(JSON.parse(resolved.assertion), {
      method: 'POST',
      path: '/services/livekit-api/DeleteRoom',
      body: body.toString('hex'),
    });
    assert.equal(globalThis.__livekitAssertionInput.body.equals(body), true);
  } finally {
    delete globalThis.__livekitResolvedServiceInput;
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
