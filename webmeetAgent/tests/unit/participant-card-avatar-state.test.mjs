import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const layoutControllerPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/participant-layout-controller.js'
);
const participantCardPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js'
);

test('participant layout controller persists avatar config and fallback attributes for late presenter init', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /applyParticipantProfileAvatar/);
    assert.match(source, /participant\?\.profileAvatar/);
    assert.match(source, /const hasProjectedAvatar = this\.applyParticipantProfileAvatar\(view, participant\)/);
    assert.match(source, /if \(!hasProjectedAvatar\)/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /data-avatar-size/);
    assert.match(source, /JSON\.stringify\(payload\.avatarConfig\)/);
});

test('participant card restores avatar config and fallback letter from element attributes', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /ensureAxiFaceLoaded/);
    assert.match(source, /function parseAvatarConfig/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /avatarConfig:\s*parseAvatarConfig\(element\.getAttribute\('data-avatar-config'\)\)/);
    assert.match(source, /avatarFallbackLetter:\s*String\(element\.getAttribute\('data-avatar-fallback-letter'\) \|\| ''\)\.trim\(\)/);
    assert.match(source, /dataset\.avatarSize = size/);
});

test('participant card keeps fallback initials until axi-face is registered', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /!customElements\.get\('axi-face'\)/);
    assert.match(source, /this\.refs\.avatar\.textContent = fallback/);
    assert.match(source, /ensureAxiFaceLoaded\(\)/);
    assert.match(source, /avatarLoadFailedKey/);
    assert.match(source, /this\.avatarLoadFailedKey === loadKey/);
    assert.match(source, /this\.avatarRenderKey = ''/);
    assert.match(source, /this\.applyState\(\)/);
});
