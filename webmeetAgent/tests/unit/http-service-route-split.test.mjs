import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('webmeet manifest does not declare legacy HTTP service prefixes', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../manifest.json'),
        'utf8'
    );
    const manifest = JSON.parse(source);
    const httpServices = Array.isArray(manifest.httpServices) ? manifest.httpServices : [];

    assert.equal(httpServices.length, 0);
    assert.doesNotMatch(source, /\/services\/webmeet/);
    assert.doesNotMatch(source, /\/public-services\/webmeet/);
});
