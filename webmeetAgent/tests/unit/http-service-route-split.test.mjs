import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('webmeet manifest separates authenticated and guest HTTP service prefixes', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../manifest.json'),
        'utf8'
    );
    const manifest = JSON.parse(source);
    const httpServices = Array.isArray(manifest.httpServices) ? manifest.httpServices : [];

    const protectedRoute = httpServices.find((entry) => entry?.externalPrefix === '/services/webmeet/');
    const guestRoute = httpServices.find((entry) => entry?.externalPrefix === '/public-services/webmeet/');

    assert.ok(protectedRoute);
    assert.equal(protectedRoute.auth, 'protected');
    assert.ok(guestRoute);
    assert.equal(guestRoute.auth, 'guest');
    assert.equal(guestRoute.forceGuest, true);
});
