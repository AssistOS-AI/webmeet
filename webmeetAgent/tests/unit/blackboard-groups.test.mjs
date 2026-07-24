import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
    GROUP_SELECTION_PADDING,
    blackboardGroupMethods,
    padGroupSelectionBounds,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel/webmeet-blackboard-groups.js';

const panelRoot = path.resolve(
    import.meta.dirname,
    '../../IDE-plugins/webmeet-tool-button/components/webmeet-blackboard/webmeet-blackboard-panel',
);

test('Robo ordinals treat each rigid group as one target', () => {
    const {widgetOrdinals, groupOrdinals} = blackboardGroupMethods.getRoboTargetOrdinals([
        {id: 'a', groupId: 'group-1'},
        {id: 'b', groupId: 'group-1'},
        {id: 'c'},
        {id: 'd', groupId: 'group-2'},
        {id: 'e', groupId: 'group-2'},
    ]);

    assert.deepEqual([...groupOrdinals.entries()], [['group-1', 1], ['group-2', 3]]);
    assert.deepEqual([...widgetOrdinals.entries()], [['c', 2]]);
});

test('group selection border keeps a stable visual gap around group members', () => {
    assert.equal(GROUP_SELECTION_PADDING, 8);
    assert.deepEqual(
        padGroupSelectionBounds({x: 20, y: 30, width: 200, height: 100}),
        {x: 12, y: 22, width: 216, height: 116},
    );
});

test('blackboard group UI exposes rigid block selection and all contextual transforms', async () => {
    const [groupSource, panelSource, renderingSource, interactionSource, css] = await Promise.all([
        fs.readFile(path.join(panelRoot, 'webmeet-blackboard-groups.js'), 'utf8'),
        fs.readFile(path.join(panelRoot, 'webmeet-blackboard-panel.js'), 'utf8'),
        fs.readFile(path.join(panelRoot, 'webmeet-blackboard-rendering.js'), 'utf8'),
        fs.readFile(path.join(panelRoot, 'webmeet-blackboard-interactions.js'), 'utf8'),
        fs.readFile(path.join(panelRoot, 'webmeet-blackboard-panel.css'), 'utf8'),
    ]);

    assert.match(panelSource, /selectedWidgetIds = new Set\(\)/);
    assert.match(panelSource, /selectedGroupId = ''/);
    assert.match(groupSource, /GROUPABLE_WIDGET_TYPES = new Set\(\['shape', 'line', 'text', 'image', 'card'\]\)/);
    assert.match(groupSource, /!this\.isGroupableWidget\(widget\)/);
    assert.match(groupSource, /widgetIds\.length !== this\.selectedWidgetIds\.size/);
    assert.match(interactionSource, /widget && this\.isGroupableWidget\(widget\).*event\.shiftKey/);
    assert.match(interactionSource, /event\.shiftKey \|\| event\.ctrlKey \|\| event\.metaKey/);
    assert.match(interactionSource, /beginMarqueeSelection\(event\)/);
    assert.match(interactionSource, /webmeet-blackboard-group-hit-area/);
    assert.match(interactionSource, /beginGroupDrag\(event, groupId, representative\)/);
    assert.match(renderingSource, /!widget\.groupId.*renderResizeHandles/);
    assert.match(renderingSource, /renderGroupHitAreas\(groupOrdinals\)/);
    assert.match(renderingSource, /getRoboTargetOrdinals\(widgets\)/);
    assert.match(groupSource, /getRoboTargetOrdinals\(widgets/);
    assert.match(groupSource, /badge\.textContent = `G\$\{ordinal\}`/);
    assert.match(groupSource, /webmeet-blackboard-group-ordinal/);
    assert.match(groupSource, /applyGroupSelectionBounds\(overlay, bounds\)/);
    assert.match(groupSource, /applyGroupSelectionBounds\(this\.groupOverlay, bounds\)/);
    assert.match(renderingSource, /if \(widget\.groupId\) return/);

    for (const action of ['Move group', 'Rotate group', 'Export group', 'Delete group', 'Ungroup widgets']) {
        assert.match(groupSource, new RegExp(action));
    }
    assert.match(groupSource, /toggleGroupExportMenu\(menu, exportButton\)/);
    assert.doesNotMatch(groupSource, /createContextButton\('resize'/);
    assert.match(groupSource, /\['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'\]/);
    assert.match(groupSource, /event\.shiftKey[\s\S]*const scale = Math\.max\(scaleX, scaleY\)/);
    assert.match(groupSource, /targetType: 'group'.*group-move/s);
    assert.match(groupSource, /targetType: 'group'.*group-resize/s);
    assert.match(groupSource, /targetType: 'group'.*group-rotate/s);
    assert.match(css, /\.webmeet-blackboard-group-overlay/);
    assert.match(css, /\.webmeet-blackboard-group-ordinal/);
    assert.match(css, /\.webmeet-blackboard-group-hit-area[\s\S]*z-index:\s*1/);
    assert.doesNotMatch(css, /\.webmeet-blackboard-widget\.is-group-selected-member[\s\S]*box-shadow/);
    assert.match(css, /\.webmeet-blackboard-selection-marquee/);
    assert.match(css, /group-resize[\s\S]*display:\s*block/);
});
