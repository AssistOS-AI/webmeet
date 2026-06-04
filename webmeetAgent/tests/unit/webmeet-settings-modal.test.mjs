import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');

test('WebMeet dashboard is a page component and settings is a WebSkel modal', async () => {
    const config = JSON.parse(await fs.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
    const dashboard = config.dependencies.find((entry) => entry.component === 'webmeet-dashbaoard');
    const settingsModal = config.dependencies.find((entry) => entry.component === 'webmeet-settings-modal');

    assert.ok(dashboard);
    assert.equal(dashboard.presenter, 'WebMeetDashbaoard');
    assert.equal(dashboard.type, undefined);
    assert.equal(settingsModal?.presenter, 'WebmeetSettingsModal');
    assert.equal(settingsModal?.type, 'modal');
});

test('WebMeet settings modal supports resize, fullscreen, and dashboard action delegation', async () => {
    const modalSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.js'),
        'utf8'
    );
    const modalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/controllers/media-settings-methods.js'),
        'utf8'
    );

    assert.match(modalSource, /ensureResizable\(\)/);
    assert.match(modalSource, /toggleFullscreen\(\)/);
    assert.match(modalSource, /webmeet:settings-modal-action/);
    assert.match(modalCss, /\.webmeet-settings-modal-content \.webmeet-hidden/);
    assert.match(modalCss, /\.webmeet-settings-resize-handle\.se/);
    assert.match(modalCss, /webmeet-settings-modal-dialog\.is-fullscreen/);
    assert.match(dashboardSource, /showModal\?\.\('webmeet-settings-modal'\)/);
    assert.match(dashboardSource, /mountMediaSettingsModal/);
    assert.match(dashboardSource, /restoreMediaSettingsPanel/);
});

test('WebMeet settings tab footer actions hide inactive tab controls inside the modal', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/webmeet-dashbaoard.html'),
        'utf8'
    );
    const mediaSettingsSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/controllers/media-settings-methods.js'),
        'utf8'
    );
    const modalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );

    assert.match(dashboardHtml, /id="webmeetAvatarSettingsActions" class="webmeet-media-settings-actions webmeet-hidden"/);
    assert.match(mediaSettingsSource, /mediaSettingsActions\?\.classList\.toggle\('webmeet-hidden', activeSettingsTab !== 'media'\)/);
    assert.match(mediaSettingsSource, /avatarSettingsActions\?\.classList\.toggle\('webmeet-hidden', activeSettingsTab !== 'avatar'\)/);
    assert.match(modalCss, /\.webmeet-settings-modal-content \.webmeet-hidden\s*\{[\s\S]*display: none !important;/);
});

test('WebMeet audio health is a microphone button badge, not a settings field', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/webmeet-dashbaoard.html'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/webmeet-dashbaoard.css'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashbaoard/webmeet-dashbaoard.js'),
        'utf8'
    );
    const settingsModalCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-settings-modal/webmeet-settings-modal.css'),
        'utf8'
    );

    assert.doesNotMatch(dashboardHtml, /webmeetAudioHealthValue/);
    assert.doesNotMatch(dashboardHtml, />Audio health</);
    assert.match(dashboardHtml, /id="webmeetMicButton"[\s\S]*id="webmeetAudioHealthIndicator"/);
    assert.match(dashboardCss, /\.webmeet-audio-health-indicator/);
    assert.doesNotMatch(settingsModalCss, /webmeet-audio-health/);
    assert.match(dashboardSource, /updateAudioHealthIndicator/);
    assert.match(dashboardSource, /Toggle Microphone - Audio: \$\{health\}/);
});
