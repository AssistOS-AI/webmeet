import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const agentRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = path.join(agentRoot, 'scripts/lib/livekit-udp-mux.sh');

// Runs one shell snippet with the lib sourced and a fake `ss` first on PATH.
// `lines` is what `ss` prints for every invocation (the lib passes -lun or -lunp).
function run(snippet, lines = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-udp-mux-test-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'ss.out'), lines.map((line) => `${line}\n`).join(''));
    fs.writeFileSync(path.join(bin, 'ss'), `#!/bin/sh\ncat '${path.join(root, 'ss.out')}'\n`, { mode: 0o755 });
    return spawnSync('sh', ['-c', `. "${lib}"; ${snippet}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const livekitOn = (port) => `UNCONN 0 0 0.0.0.0:${port} 0.0.0.0:* users:(("livekit-server",pid=12,fd=9))`;
const plainOn = (port) => `UNCONN 0 0 0.0.0.0:${port} 0.0.0.0:*`;

test('livekit_owns_udp follows the selected port', () => {
  assert.equal(run('livekit_owns_udp 7890', [livekitOn(7890)]).status, 0);
  assert.equal(run('livekit_owns_udp 7882', [livekitOn(7890)]).status, 1);
  assert.equal(run('livekit_owns_udp 7882', [livekitOn(7882)]).status, 0);
});

test('livekit_owns_udp requires the livekit-server owner and an exact port suffix', () => {
  assert.equal(run('livekit_owns_udp 7890', [plainOn(7890)]).status, 1);
  assert.equal(run('livekit_owns_udp 7890', [livekitOn(17890)]).status, 1);
  assert.equal(run('livekit_owns_udp 7890', []).status, 1);
});

test('forbidden_udp_listener_present excludes the selected port', () => {
  assert.equal(run('forbidden_udp_listener_present 7890', [livekitOn(7890)]).status, 1);
  assert.equal(run('forbidden_udp_listener_present 7882', [livekitOn(7890)]).status, 0);
  assert.equal(run('forbidden_udp_listener_present 7882', [livekitOn(7882)]).status, 1);
  assert.equal(run('forbidden_udp_listener_present 7890', [plainOn(3478)]).status, 0);
  assert.equal(run('forbidden_udp_listener_present 7890', [plainOn(5349)]).status, 0);
  assert.equal(run('forbidden_udp_listener_present 7890', [plainOn(7891)]).status, 0);
  assert.equal(run('forbidden_udp_listener_present 7890', [plainOn(17891)]).status, 1);
});

test('forbidden_udp_listener_present flags the whole range when the mux is outside it', () => {
  for (let port = 7883; port <= 7892; port += 1) {
    assert.equal(run('forbidden_udp_listener_present 7882', [plainOn(port)]).status, 0, String(port));
  }
});

test('health reports the selected port when livekit-server owns a different one', () => {
  const result = run(
    'livekit_owns_udp 7893 || { echo "LiveKit does not own 7893/udp"; exit 3; }',
    [livekitOn(7882)],
  );
  assert.equal(result.status, 3);
  assert.match(result.stdout, /LiveKit does not own 7893\/udp/);
});

test('livekit_valid_udp_port accepts only canonical ports', () => {
  for (const value of ['1', '7882', '7893', '65535']) {
    assert.equal(run(`livekit_valid_udp_port '${value}'`).status, 0, value);
  }
  for (const value of ['', '0', '65536', '-1', '07893', '7893.0', '1e4', 'abc', '123456', ' 7893']) {
    assert.equal(run(`livekit_valid_udp_port '${value}'`).status, 1, JSON.stringify(value));
  }
});

test('livekit_udp_port_from_config prints only a valid canonical rtc.udp_port', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-udp-config-test-'));
  try {
    const cases = [
      [{ rtc: { udp_port: 7893 } }, 0, '7893\n'],
      [{ rtc: { udp_port: 0 } }, 1, ''],
      [{ rtc: { udp_port: 65536 } }, 1, ''],
      [{ rtc: { udp_port: '7893' } }, 1, ''],
      [{ rtc: { udp_port: 7893.5 } }, 1, ''],
      [{ rtc: {} }, 1, ''],
      [{}, 1, ''],
    ];
    cases.forEach(([content, status, stdout], index) => {
      const file = path.join(root, `livekit-${index}.yaml`);
      fs.writeFileSync(file, JSON.stringify(content));
      const result = run(`livekit_udp_port_from_config '${file}'`);
      assert.equal(result.status, status, JSON.stringify(content));
      assert.equal(result.stdout, stdout, JSON.stringify(content));
    });
    assert.equal(run(`livekit_udp_port_from_config '${path.join(root, 'missing.yaml')}'`).status, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
