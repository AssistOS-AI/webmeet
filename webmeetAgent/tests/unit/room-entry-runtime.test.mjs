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

test('standalone WebMeet MCP requests carry a route-scoped browser mutation proof', async () => {
    const roomLoader = await fs.readFile(
        path.resolve(import.meta.dirname, '../../static-files/roomLoader.js'),
        'utf8'
    );

    assert.match(roomLoader, /searchParams\.set\('mutationRoute', getWebMeetAgentName\(\)\)/);
    assert.match(roomLoader, /searchParams\.set\('mutationRoute', agentId\)/);
    assert.equal(
        roomLoader.match(/searchParams\.set\('mutationPath', window\.location\.pathname\)/g)?.length,
        2
    );
    assert.equal(
        roomLoader.match(/proofUrl\.searchParams\.set\('roomId', roomId\)/g)?.length,
        2
    );
    assert.match(roomLoader, /proof\.routeKey !== agentId/);
    assert.match(roomLoader, /proof\.origin !== window\.location\.origin/);
    assert.match(roomLoader, /headers\.set\(BROWSER_CSRF_HEADER, mutationToken\)/);
    assert.match(roomLoader, /'browser_csrf_invalid'/);
    assert.match(roomLoader, /'edge_generation_changed'/);
    assert.match(roomLoader, /response = await request\(true\)/);
});
