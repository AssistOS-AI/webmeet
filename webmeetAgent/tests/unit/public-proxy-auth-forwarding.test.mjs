import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('authenticated WebMeet proxy forwards verified user identity to the API header', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../server/webmeet-public-proxy.mjs'),
        'utf8'
    );

    assert.match(source, /function authInfoFromInvocation\(/);
    assert.match(source, /normalized = authInfoFromInvocation\(verifiedPayload, \{ invocationToken \}\)/);
    assert.match(source, /req\.headers\['x-ploinky-auth-info'\]\s*=\s*JSON\.stringify\(merged\)/);
});

test('authenticated WebMeet proxy rejects spoofable user headers without verified invocation token', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../server/webmeet-public-proxy.mjs'),
        'utf8'
    );

    assert.doesNotMatch(source, /function hasAuthenticatedUserInfo\(/);
    assert.doesNotMatch(source, /hasAuthenticatedUserInfo\(readPloinkyAuthInfo\(req\)\)/);
    const method = source.slice(
        source.indexOf('async function requirePloinkyAuthenticatedIdentity'),
        source.indexOf('\n}\n\nfunction parseJsonRpcPayload', source.indexOf('async function requirePloinkyAuthenticatedIdentity'))
    );
    assert.match(method, /verifyRouterInvocation\(req, url, \{ requireGuest: false \}\)/);
    assert.match(method, /if \(verified\.ok\)/);
    assert.match(method, /writeResponse\(res, 401/);
});
