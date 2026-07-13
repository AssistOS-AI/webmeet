import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const agentRoot = path.resolve(import.meta.dirname, '../..');
const repoRoot = path.dirname(agentRoot);

async function readJson(filePath) {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('WebMeet owns no TURN/STUN topology and blocks on both infra agents', async () => {
    const manifest = await readJson(path.join(agentRoot, 'manifest.json'));
    assert.deepEqual(manifest.network, {
        mode: 'bridge',
        attachments: [
            { name: 'webmeet-signaling', primary: true },
        ],
    });
    assert.equal(JSON.stringify(manifest.network).includes('aliases'), false);
    assert.deepEqual(manifest.enable, [
        'webmeetInfra/liveKitServerAgent',
        'webmeetInfra/turnServerAgent',
    ]);
    assert.equal(JSON.stringify(manifest).includes('no-wait'), false);
    assert.equal(JSON.stringify(manifest).includes('preinstall'), false);

    const retiredNames = [
        'WEBMEET_LOCAL_PUBLIC_HOST',
        'WEBMEET_STUN_URLS',
        'WEBMEET_TURN_EXTERNAL_IP',
        'WEBMEET_TURN_HOST',
        'WEBMEET_TURN_PORT',
        'WEBMEET_TURN_URLS',
        'WEBMEET_TURN_REALM',
        'WEBMEET_TURN_USER',
        'WEBMEET_TURN_PASSWORD',
        'WEBMEET_TURN_MIN_PORT',
        'WEBMEET_TURN_MAX_PORT',
    ];
    for (const name of retiredNames) {
        assert.equal(JSON.stringify(manifest).includes(name), false, `${name} must not be declared by webmeetAgent`);
    }
});

test('late provider URL entries use the Ploinky-validator-safe shape and have no fallback', async () => {
    const manifest = await readJson(path.join(agentRoot, 'manifest.json'));
    for (const [profileName, profile] of Object.entries(manifest.profiles)) {
        for (const name of ['WEBMEET_PUBLIC_LIVEKIT_URL', 'WEBMEET_LIVEKIT_URL']) {
            const entry = profile.env.find((candidate) => candidate?.name === name);
            assert.ok(entry, `${profileName} must declare ${name}`);
            assert.equal(entry.required, false, `${name} must be satisfiable by the late config provider`);
            assert.equal(Object.hasOwn(entry, 'default'), false, `${name} must not have an agent-owned fallback`);
        }
    }

    const startScript = await fs.readFile(path.join(agentRoot, 'scripts/startAgent.sh'), 'utf8');
    assert.match(startScript, /WEBMEET_PUBLIC_LIVEKIT_URL must be provided by the Web Publishing config provider/);
    assert.match(startScript, /WEBMEET_LIVEKIT_URL must be provided by the Web Publishing config provider/);
});

test('startup fails closed after provider resolution when signaling values or ICE policy are invalid', () => {
    const script = path.join(agentRoot, 'scripts/startAgent.sh');
    const baseEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        WEBMEET_DATA_DIR: path.join(process.env.TMPDIR || '/tmp', 'webmeet-network-contract-data'),
    };

    const missingPublic = spawnSync('sh', [script], { env: baseEnv, encoding: 'utf8' });
    assert.notEqual(missingPublic.status, 0);
    assert.match(missingPublic.stderr, /WEBMEET_PUBLIC_LIVEKIT_URL must be provided/);

    const missingInternal = spawnSync('sh', [script], {
        env: { ...baseEnv, WEBMEET_PUBLIC_LIVEKIT_URL: 'wss://meet.example.com' },
        encoding: 'utf8',
    });
    assert.notEqual(missingInternal.status, 0);
    assert.match(missingInternal.stderr, /WEBMEET_LIVEKIT_URL must be provided/);

    const invalidIce = spawnSync('sh', [script], {
        env: {
            ...baseEnv,
            WEBMEET_PUBLIC_LIVEKIT_URL: 'wss://meet.example.com',
            WEBMEET_LIVEKIT_URL: 'http://livekitserveragent:7880',
            WEBMEET_ICE_TRANSPORT_POLICY: 'prefer-relay',
        },
        encoding: 'utf8',
    });
    assert.notEqual(invalidIce.status, 0);
    assert.match(invalidIce.stderr, /must be exactly "all" or "relay"/);
});

test('Explorer has one blocking WebMeet edge and no direct LiveKit edge', async () => {
    const manifest = await readJson(path.join(repoRoot, 'explorer/manifest.json'));
    assert.ok(manifest.enable.includes('webmeetAgent global'));
    assert.equal(manifest.enable.some((entry) => String(entry?.agent || entry).includes('webmeetAgent global no-wait')), false);
    assert.equal(manifest.enable.some((entry) => String(entry?.agent || entry).includes('webmeetInfra/liveKitServerAgent')), false);
});

test('WebMeet STT stays on an isolated default network', async () => {
    const manifest = await readJson(path.join(repoRoot, 'webmeetStt/manifest.json'));
    assert.deepEqual(manifest.network, { mode: 'default' });
    assert.equal(JSON.stringify(manifest.network).includes('aliases'), false);
});
