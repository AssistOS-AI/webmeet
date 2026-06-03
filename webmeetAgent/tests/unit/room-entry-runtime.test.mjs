import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('WebMeet room entry uses Explorer runtime plugin loading, not a public proxy', async () => {
    const explorerMain = await fs.readFile(
        path.resolve(import.meta.dirname, '../../../explorer/main.js'),
        'utf8'
    );
    const proxyPath = path.resolve(import.meta.dirname, '../../server', `webmeet-public-${'proxy'}.mjs`);

    await assert.rejects(fs.access(proxyPath), /ENOENT/);
    assert.match(explorerMain, /runtimePluginLoader\.fetchRuntimePlugins\(\)/);
    assert.match(explorerMain, /hasWebMeetRuntimePlugin\(runtimePlugins\)/);
    assert.doesNotMatch(explorerMain, /createRoomEntryRuntimePlugins/);
    assert.doesNotMatch(explorerMain, /\/workspace-files\/\$\{assetRootPath\}/);
    assert.doesNotMatch(explorerMain, new RegExp(`guest${'-plugins'}`));
});
