import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const sharedAvatarSettingsCssPath = path.join(
    repoRoot,
    '../shared/ui/avatar-settings-form/avatar-settings-form.css'
);

test('shared avatar settings form groups fields in aligned responsive sections', async () => {
    const css = await fs.readFile(sharedAvatarSettingsCssPath, 'utf8');

    assert.match(css, /avatar-settings-form \.avatar-settings-section\s*\{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(150px, 1fr\)\)/);
    assert.match(css, /avatar-settings-form \.avatar-settings-section\s*\{[\s\S]*align-items: end/);
    assert.match(css, /avatar-settings-form \.avatar-settings-section\s*\{[\s\S]*border: 1px solid var\(--border/);
    assert.match(css, /avatar-settings-form \.avatar-settings-field\s*\{[\s\S]*grid-template-rows: auto 36px/);
});
