import net from 'node:net';
import tls from 'node:tls';

import { resolveLiveKitRouterTransport } from './runtime-config.mjs';

const MAX_HANDSHAKE_BYTES = 64 * 1024;

function reject(client, status, message) {
    const body = `${message}\n`;
    client.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
    );
}

function canonicalRequestTarget(requestTarget, signalPath) {
    const queryIndex = requestTarget.indexOf('?');
    const rawPath = queryIndex < 0 ? requestTarget : requestTarget.slice(0, queryIndex);
    const query = queryIndex < 0 ? '' : requestTarget.slice(queryIndex);
    if (rawPath.startsWith(`${signalPath}/`)) {
        return `${signalPath}${rawPath.slice(signalPath.length + 1)}${query}`;
    }
    return requestTarget;
}

function authorityHeader(handshake, requestAuthority, requestTarget, signalPath) {
    const lines = handshake.split('\r\n');
    lines[0] = `GET ${canonicalRequestTarget(requestTarget, signalPath)} HTTP/1.1`;
    let replaced = false;
    const rewritten = lines.map((line, index) => {
        if (index > 0 && /^host:/i.test(line)) {
            replaced = true;
            return `Host: ${requestAuthority}`;
        }
        return line;
    });
    if (!replaced) rewritten.splice(1, 0, `Host: ${requestAuthority}`);
    return rewritten.join('\r\n');
}

export async function startRouterWebSocketAuthorityProxy({ environment = process.env } = {}) {
    const { routerUrl, requestAuthority, signalPath } = resolveLiveKitRouterTransport(environment);
    const server = net.createServer((client) => {
        let pending = Buffer.alloc(0);
        let connected = false;

        const fail = (error) => {
            if (!client.destroyed) client.destroy(error);
        };

        client.on('error', () => {});
        client.on('data', function onHandshake(chunk) {
            if (connected) return;
            pending = Buffer.concat([pending, chunk]);
            if (pending.length > MAX_HANDSHAKE_BYTES) {
                client.off('data', onHandshake);
                reject(client, '431 Request Header Fields Too Large', 'WebSocket handshake is too large.');
                return;
            }
            const boundary = pending.indexOf('\r\n\r\n');
            if (boundary < 0) return;

            client.off('data', onHandshake);
            const header = pending.subarray(0, boundary + 4).toString('latin1');
            const remainder = pending.subarray(boundary + 4);
            const requestLine = header.slice(0, header.indexOf('\r\n'));
            const match = /^GET ([^ ]+) HTTP\/1\.1$/.exec(requestLine);
            let pathname = '';
            try { pathname = new URL(match?.[1] || '', 'http://relay.invalid').pathname; } catch {}
            if (!match || !pathname.startsWith(signalPath)) {
                reject(client, '403 Forbidden', 'WebSocket path is outside the LiveKit signaling route.');
                return;
            }

            connected = true;
            const options = {
                host: routerUrl.hostname,
                port: Number(routerUrl.port || (routerUrl.protocol === 'https:' ? 443 : 80)),
                ...(routerUrl.protocol === 'https:' ? { servername: routerUrl.hostname } : {}),
            };
            const upstream = routerUrl.protocol === 'https:'
                ? tls.connect(options)
                : net.createConnection(options);
            upstream.once('error', fail);
            upstream.once('connect', () => {
                upstream.write(authorityHeader(header, requestAuthority, match[1], signalPath), 'latin1');
                if (remainder.length) upstream.write(remainder);
                client.pipe(upstream);
                upstream.pipe(client);
            });
            client.once('close', () => upstream.destroy());
        });
    });

    await new Promise((resolve, rejectPromise) => {
        server.once('error', rejectPromise);
        server.listen({ host: '127.0.0.1', port: 0 }, () => {
            server.off('error', rejectPromise);
            resolve();
        });
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('LiveKit Router WebSocket relay did not bind a TCP port.');
    }
    return Object.freeze({
        livekitUrl: `ws://127.0.0.1:${address.port}${signalPath}`,
        close: () => new Promise((resolve) => server.close(resolve)),
    });
}
