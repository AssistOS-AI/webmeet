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

// Runs the real health port selection (the function the health script calls)
// against a temp port file, a fake `ss` and a fake `stat` reporting `statOut`.
function runHealthPort({ file, statOut = '0:0:444', env = {}, ssLines = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'livekit-health-port-test-'));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(root, 'ss.out'), ssLines.map((line) => `${line}\n`).join(''));
    fs.writeFileSync(path.join(bin, 'ss'), `#!/bin/sh\ncat '${path.join(root, 'ss.out')}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'stat'), `#!/bin/sh\nprintf '%s\\n' '${statOut}'\n`, { mode: 0o755 });
    const target = path.join(root, 'livekit-udp-port');
    if (file?.symlinkTo) fs.symlinkSync(file.symlinkTo, target);
    else if (file !== undefined) fs.writeFileSync(target, file);
    const cleanEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    delete cleanEnv.PLOINKY_BOX_MEDIA_PORT;
    return spawnSync('sh', ['-c', `. "${lib}"; livekit_check_selected_udp_port "${target}" || { echo "$LIVEKIT_UDP_PORT_ERROR"; exit 3; }; echo "port=$livekit_udp_port"`], {
      encoding: 'utf8',
      env: { ...cleanEnv, ...env },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const livekitSocket = (port) => `UNCONN 0 0 0.0.0.0:${port} 0.0.0.0:* users:(("livekit-server",pid=12,fd=9))`;

test('health port selection fails when LiveKit owns a different port than the port file', () => {
  const result = runHealthPort({ file: '7893\n', ssLines: [livekitSocket(7882)] });
  assert.equal(result.status, 3);
  assert.match(result.stdout, /LiveKit does not own 7893\/udp/);
});

test('health port selection accepts the port file when LiveKit owns it', () => {
  const result = runHealthPort({ file: '7891\n', ssLines: [livekitSocket(7891)] });
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /port=7891/);
});

test('health port selection falls back to 7882 only when the file and the env are absent', () => {
  const ok = runHealthPort({ ssLines: [livekitSocket(7882)] });
  assert.equal(ok.status, 0, ok.stdout);
  assert.match(ok.stdout, /port=7882/);
  const blank = runHealthPort({ env: { PLOINKY_BOX_MEDIA_PORT: '  ' }, ssLines: [livekitSocket(7882)] });
  assert.equal(blank.status, 0, blank.stdout);
  const set = runHealthPort({ env: { PLOINKY_BOX_MEDIA_PORT: '7893' }, ssLines: [livekitSocket(7882)] });
  assert.equal(set.status, 3);
  assert.match(set.stdout, /port file is missing/);
});

test('health port selection rejects bad port files', () => {
  const ss = [livekitSocket(7893)];
  const mode = runHealthPort({ file: '7893\n', statOut: '0:0:644', ssLines: ss });
  assert.equal(mode.status, 3);
  assert.match(mode.stdout, /ownership or mode is invalid/);
  const malformed = runHealthPort({ file: '07893\n', ssLines: ss });
  assert.equal(malformed.status, 3);
  assert.match(malformed.stdout, /malformed/);
  const link = runHealthPort({ file: { symlinkTo: '/etc/hostname' }, ssLines: ss });
  assert.equal(link.status, 3);
  assert.match(link.stdout, /missing or invalid/);
});

test('start script publishes the port file before invoking the in-start health check', () => {
  const start = fs.readFileSync(path.join(agentRoot, 'scripts/start-livekit-server-agent.sh'), 'utf8');
  const write = start.indexOf('mv -f "${LIVEKIT_UDP_PORT_FILE}.tmp" "$LIVEKIT_UDP_PORT_FILE"');
  const health = start.indexOf('sh /code/scripts/health/livekit-server-agent-health.sh');
  assert.notEqual(write, -1);
  assert.notEqual(health, -1);
  assert.ok(write < health, 'port file must exist before health runs');
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
