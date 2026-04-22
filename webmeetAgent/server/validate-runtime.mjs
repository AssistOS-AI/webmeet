import net from 'node:net';

const profile = String(process.env.PLOINKY_PROFILE || 'dev').trim().toLowerCase();
const isDev = profile === 'dev';
const livekitPort = isDev ? 7880 : 7880;
const livekitRtcTcpPort = isDev ? 7881 : 7881;
const egressPort = isDev ? 17980 : 7980;
const coturnPort = isDev ? 13478 : 3478;
const redisPort = isDev ? 16379 : 6379;

const checks = [
    { name: 'webmeet-api', type: 'http', url: `http://127.0.0.1:${process.env.WEBMEET_API_PORT || '8791'}/healthz` },
    { name: 'livekit-signaling', type: 'tcp', host: '127.0.0.1', port: livekitPort },
    { name: 'livekit-rtc-tcp', type: 'tcp', host: '127.0.0.1', port: livekitRtcTcpPort },
    { name: 'livekit-egress', type: 'tcp', host: '127.0.0.1', port: egressPort },
    { name: 'coturn-tcp', type: 'tcp', host: '127.0.0.1', port: coturnPort },
    { name: 'redis', type: 'tcp', host: '127.0.0.1', port: redisPort }
];

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
