import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('webmeet_meeting_join input schema accepts nested avatar payloads', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../mcp-config.json'),
        'utf8'
    );
    const config = JSON.parse(source);
    const joinTool = config.tools.find((entry) => entry?.name === 'webmeet_meeting_join');

    assert.ok(joinTool);
    assert.equal(joinTool.inputSchema.avatar.type, 'object');
    assert.equal(joinTool.inputSchema.avatar.properties.config.type, 'object');
    assert.equal(joinTool.inputSchema.avatar.properties.config.properties.seed.type, 'string');
});
