import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('public WebMeet proxy disables asset caching to avoid stale participant UI code', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../server/webmeet-public-proxy.mjs'),
        'utf8'
    );

    assert.match(source, /'Cache-Control': 'no-store'/);
    assert.doesNotMatch(source, /'Cache-Control': extension === '\.html' \? 'no-store' : 'public, max-age=3600'/);
});

test('public WebMeet proxy serves background effect wasm with the correct MIME type', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../server/webmeet-public-proxy.mjs'),
        'utf8'
    );

    assert.match(source, /\['\.wasm', 'application\/wasm'\]/);
    assert.match(source, /\['\.mjs', 'application\/javascript; charset=utf-8'\]/);
});
