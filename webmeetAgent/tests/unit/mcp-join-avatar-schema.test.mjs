import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('webmeet_room_join input schema accepts avatar payloads', async () => {
    const source = await fs.readFile(
        path.resolve(import.meta.dirname, '../../mcp-config.json'),
        'utf8'
    );
    const config = JSON.parse(source);
    const joinTool = config.tools.find((entry) => entry?.name === 'webmeet_room_join');

    assert.ok(joinTool);
    assert.equal(joinTool.inputSchema.avatar.type, 'object');
});
