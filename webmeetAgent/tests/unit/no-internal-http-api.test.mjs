import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('WebMeet no longer ships an internal HTTP API server', async () => {
    const apiPath = path.resolve(import.meta.dirname, '../../server', `webmeet-${'api'}.mjs`);
    await assert.rejects(fs.access(apiPath), /ENOENT/);
});
