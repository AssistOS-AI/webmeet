import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));

test('webmeetAgent supports only global mode so an on-demand enable without a mode resolves the workspace root', () => {
    assert.deepEqual(manifest.enableModes, ['global']);
    assert.deepEqual(manifest.enable, ['liveKitServerAgent no-wait']);
});
