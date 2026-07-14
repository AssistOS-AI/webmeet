import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const explorerManifestPath = path.resolve(agentRoot, '../explorer/manifest.json');
const scriptPath = path.join(agentRoot, 'readiness.sh');

function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(agentRoot, 'manifest.json'), 'utf8'));
}

function entriesByName(profileConfig) {
  return new Map((profileConfig.env || []).map((entry) => [entry.name, entry]));
}

async function runReadiness(port) {
  try {
    const result = await execFileAsync('sh', [scriptPath], {
      cwd: agentRoot,
      env: { ...process.env, WEBMEET_STT_PORT: String(port) },
    });
    return { status: 0, ...result };
  } catch (error) {
    return {
      status: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout || '',
      stderr: error.stderr || '',
    };
  }
}

async function createHealthServer(statusCode) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(statusCode, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: statusCode === 200 }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('manifest keeps STT isolated and private with an in-container health probe', () => {
  const manifest = readManifest();

  assert.deepEqual(manifest.network, { mode: 'default' });
  assert.equal(manifest.readiness, undefined);
  assert.deepEqual(manifest.health?.readiness, {
    script: 'readiness.sh',
    interval: 2,
    timeout: 5,
    failureThreshold: 90,
  });
  assert.equal(manifest.httpServices, undefined);

  for (const profileName of ['default', 'dev', 'prod']) {
    const profile = manifest.profiles?.[profileName];
    assert.ok(profile, `profile ${profileName} exists`);
    assert.equal(profile.openPorts, undefined, `${profileName} publishes no STT listener across the box boundary`);
    assert.equal(profile.additionalServerPort, undefined, `${profileName} does not create an unused router surface`);
    assert.deepEqual(entriesByName(profile).get('WEBMEET_STT_PORT'), {
      name: 'WEBMEET_STT_PORT',
      required: false,
      default: '9000',
    });
  }
});

test('Explorer launches optional STT without gating its own startup', () => {
  const explorerManifest = JSON.parse(fs.readFileSync(explorerManifestPath, 'utf8'));

  assert.equal(explorerManifest.enable.includes('webmeetStt no-wait'), true);
  assert.equal(explorerManifest.enable.includes('webmeetStt'), false);
});

test('readiness probe has valid shell syntax', () => {
  const result = spawnSync('sh', ['-n', scriptPath], {
    cwd: agentRoot,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('readiness requires an exact HTTP 200 from the private health endpoint', async () => {
  const readyServer = await createHealthServer(200);
  try {
    const ready = await runReadiness(readyServer.port);
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    assert.match(ready.stdout, /ready/);
    assert.deepEqual(readyServer.requests, ['/healthz']);
  } finally {
    await readyServer.close();
  }

  const unhealthyServer = await createHealthServer(503);
  try {
    const unhealthy = await runReadiness(unhealthyServer.port);
    assert.notEqual(unhealthy.status, 0);
    assert.match(unhealthy.stdout, /\/healthz is not ready/);
    assert.deepEqual(unhealthyServer.requests, ['/healthz']);
  } finally {
    await unhealthyServer.close();
  }

  const unreachable = await runReadiness(readyServer.port);
  assert.notEqual(unreachable.status, 0);
  assert.match(unreachable.stdout, /\/healthz is not ready/);
});
