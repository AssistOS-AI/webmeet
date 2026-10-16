import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('webmeet manifest does not declare legacy HTTP route prefixes', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../manifest.json'),
        'utf8'
    );
    const manifest = JSON.parse(source);
    assert.equal(Object.hasOwn(manifest, 'httpServices'), false);
    assert.doesNotMatch(source, /\/services\/webmeet/);
    assert.doesNotMatch(source, /\/public-services\/webmeet/);
});
