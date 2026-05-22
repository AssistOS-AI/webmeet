import net from 'node:net';

const DEFAULT_WEBMEET_API_PORT = 8791;
const DEFAULT_LIVEKIT_PUBLIC_URL = 'ws://127.0.0.1:7880';
const DEFAULT_LIVEKIT_API_URL = 'http://liveKitServerAgent:7880';
const DEFAULT_EGRESS_URL = 'http://liveKitServerAgent:7980';

function normalizePort(protocol, portText) {
    if (portText) {
        const parsed = Number.parseInt(portText, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
            return parsed;
        }
    }
    if (protocol === 'https:' || protocol === 'wss:') {
        return 443;
    }
    return 80;
}

function buildTcpCheck(name, rawUrl) {
    const trimmed = String(rawUrl || '').trim();
    if (!trimmed) {
        return null;
    }
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch (error) {
        throw new Error(`Invalid ${name} URL "${trimmed}": ${error instanceof Error ? error.message : String(error)}`);
    }
    let host = parsed.hostname;
    if (name === 'livekit-public' && (host === '127.0.0.1' || host === 'localhost')) {
        host = process.env.PLOINKY_RUNTIME === 'docker'
            ? 'host.docker.internal'
            : 'host.containers.internal';
    }
    return {
        name,
        type: 'tcp',
        host,
        port: normalizePort(parsed.protocol, parsed.port)
    };
}

function getChecks() {
    const checks = [
        {
            name: 'webmeet-api',
            type: 'http',
            url: `http://127.0.0.1:${process.env.WEBMEET_API_PORT || DEFAULT_WEBMEET_API_PORT}/healthz`
        },
        buildTcpCheck(
            'livekit',
            process.env.WEBMEET_LIVEKIT_URL || process.env.WEBMEET_PUBLIC_LIVEKIT_URL || DEFAULT_LIVEKIT_API_URL
        ),
        buildTcpCheck(
            'livekit-public',
            process.env.WEBMEET_PUBLIC_LIVEKIT_URL || process.env.WEBMEET_LIVEKIT_URL || DEFAULT_LIVEKIT_PUBLIC_URL
        ),
        buildTcpCheck(
            'livekit-egress',
            process.env.WEBMEET_EGRESS_URL || DEFAULT_EGRESS_URL
        )
    ].filter(Boolean);

    const deduped = [];
    const seen = new Set();
    for (const check of checks) {
        const signature = check.type === 'http'
            ? `${check.type}:${check.url}`
            : `${check.type}:${check.host}:${check.port}`;
        if (seen.has(signature)) {
            continue;
        }
        seen.add(signature);
        deduped.push(check);
    }
    return deduped;
}

async function checkHttp(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    return true;
}

async function checkTcp(host, port, timeoutMs = 1500) {
    await new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const finish = (error) => {
            socket.destroy();
            if (error) reject(error);
            else resolve();
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish());
        socket.once('timeout', () => finish(new Error('timeout')));
        socket.once('error', (error) => finish(error));
        socket.connect(port, host);
    });
}

async function main() {
    const checks = getChecks();
    const results = [];
    let hasError = false;
    for (const check of checks) {
        try {
            if (check.type === 'http') {
                await checkHttp(check.url);
            } else {
                await checkTcp(check.host, check.port);
            }
            results.push({ ...check, ok: true });
        } catch (error) {
            hasError = true;
            results.push({ ...check, ok: false, error: error instanceof Error ? error.message : String(error) });
        }
    }
    process.stdout.write(`${JSON.stringify({ ok: !hasError, checks: results }, null, 2)}\n`);
    if (hasError) process.exit(1);
}

main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
});
