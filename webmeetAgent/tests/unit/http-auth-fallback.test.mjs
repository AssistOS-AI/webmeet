import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('authenticated HTTP routes use request auth before body actor fallback', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../server/webmeet-api.mjs'),
        'utf8'
    );

    assert.match(source, /route\.name === 'meetings\.join'[\s\S]*authInfo: getRequestActor\(req, body\)/);
    assert.match(source, /route\.name === 'meetings\.participant\.avatar'[\s\S]*authInfo: getRequestActor\(req, body\)/);
    assert.match(source, /route\.name === 'meetings\.list' \|\| route\.name === 'meetings\.create'[\s\S]*authInfo: getRequestActor\(req, body\)/);
    assert.match(source, /function getRequestActor\(req, body = null\) \{[\s\S]*const raw = String\(req\.headers\?\.\['x-ploinky-auth-info'\][\s\S]*return getActor\(body\);/);
});
