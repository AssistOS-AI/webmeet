import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('room loader retains startup coverage until the mounted dashboard reaches a render frame', async () => {
    const source = await readFile(new URL('../../static-files/roomLoader.js', import.meta.url), 'utf8');
    const begin = source.indexOf('  const dashboardReady = waitForDashboardReady();');
    const end = source.indexOf('\n}', begin);
    assert.ok(begin > 0 && end > begin);
    let mounted, ready;
    const mounting = new Promise(resolve => { mounted = resolve; });
    const readiness = new Promise(resolve => { ready = resolve; });
    const frames = [];
    let closed = false;
    const pending = vm.runInNewContext(`(async () => { ${source.slice(begin, end)} })()`, {
        webSkel: { changeToDynamicPage: () => mounting },
        waitForDashboardReady: () => readiness,
        requestAnimationFrame: callback => frames.push(callback),
        closeStartupLoaders: () => { closed = true; },
    });
    assert.equal(closed, false);
    mounted();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    ready();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false);
    frames.shift()();
    await pending;
    assert.equal(closed, true);
    const html = await readFile(new URL('../../roomLoader.html', import.meta.url), 'utf8');
    assert.match(html, /<html[^>]*data-app-loading="true"/);
    assert.match(source, /function closeStartupLoaders\(\)[\s\S]*setAttribute\('data-app-loading', 'false'\)/);
});
