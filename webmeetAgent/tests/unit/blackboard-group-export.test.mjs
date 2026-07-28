import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    GROUP_EXPORT_EXCLUDED_SELECTOR,
    calculatePngScale,
    calculateRotatedBounds,
    externalCssResourceUrls,
    groupExportFilename,
    selectGroupExportWidgets,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-export.js';

test('group export includes members and only attached connections internal to the group', () => {
    const widgets = [
        {id: 'a', type: 'shape', groupId: 'g'},
        {id: 'b', type: 'shape', groupId: 'g'},
        {id: 'c', type: 'shape', groupId: 'other'},
        {id: 'internal', type: 'line', properties: {connection: {from: {widgetId: 'a'}, to: {widgetId: 'b'}}}},
        {id: 'external', type: 'line', properties: {connection: {from: {widgetId: 'a'}, to: {widgetId: 'c'}}}},
    ];
    assert.deepEqual(selectGroupExportWidgets(widgets, 'g').map((widget) => widget.id), ['a', 'b', 'internal']);
});

test('group export bounds include widget rotation', () => {
    const bounds = calculateRotatedBounds([{x: 10, y: 20, width: 100, height: 50, rotation: 90}]);
    assert.ok(Math.abs(bounds.x - 35) < 1e-9);
    assert.ok(Math.abs(bounds.y - -5) < 1e-9);
    assert.ok(Math.abs(bounds.width - 50) < 1e-9);
    assert.ok(Math.abs(bounds.height - 100) < 1e-9);
});

test('group PNG scale is 2x normally and respects side and pixel caps', () => {
    assert.equal(calculatePngScale(1000, 500), 2);
    assert.equal(calculatePngScale(5000, 100), 8192 / 5000);
    assert.ok(calculatePngScale(5000, 5000) <= Math.sqrt(32_000_000 / 25_000_000));
});

test('group export filename and exclusions are explicit', () => {
    const date = new Date('2026-07-24T10:11:12.345Z');
    assert.equal(groupExportFilename('transparent', date), 'webmeet-group-2026-07-24T10-11-12-345Z-transparent.png');
    assert.equal(groupExportFilename('board', date), 'webmeet-group-2026-07-24T10-11-12-345Z-board.png');
    for (const selector of [
        '.webmeet-blackboard-context-menu',
        '.webmeet-blackboard-widget-ordinal',
        '.webmeet-blackboard-poll-admin-actions',
        '.webmeet-scripta-chapter-actions',
        '.webmeet-scripta-paragraph-nav',
    ]) assert.match(GROUP_EXPORT_EXCLUDED_SELECTOR, new RegExp(selector.replaceAll('.', '\\.')));
});

test('group export is local and does not call the blackboard adapter', async () => {
    const source = await fs.readFile(path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-export.js',
    ), 'utf8');
    assert.doesNotMatch(source, /adapter\?*\.?send|runFinalChange|sendChange/);
    assert.doesNotMatch(source, /<foreignObject|svgToImage/);
    assert.match(source, /html2canvas\(stage/);
    assert.match(source, /foreignObjectRendering:\s*false/);
    assert.match(source, /normalizeModernCssColors/);
    assert.match(source, /if \(download\) triggerDownload\(blob/);
});

test('group export vendors its rasterizer and license locally', async () => {
    const vendorRoot = path.resolve(panelRootForExport(), '../vendor/html2canvas');
    const [bundle, license, notice] = await Promise.all([
        fs.readFile(path.join(vendorRoot, 'html2canvas.esm.js'), 'utf8'),
        fs.readFile(path.join(vendorRoot, 'LICENSE'), 'utf8'),
        fs.readFile(path.join(vendorRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8'),
    ]);
    assert.match(bundle, /html2canvas 1\.4\.1/);
    assert.match(license, /Permission is hereby granted, free of charge/);
    assert.match(notice, /sha512-fPU6BHNpsyIhr8yy/);
});

test('group export detects every non-embedded CSS image resource', () => {
    assert.deepEqual(externalCssResourceUrls(
        'url("/icons/export.svg"), linear-gradient(red, blue), url(data:image/png;base64,abc), url(#marker)',
    ), ['/icons/export.svg']);
});

function panelRootForExport() {
    return path.resolve(
        import.meta.dirname,
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel',
    );
}
