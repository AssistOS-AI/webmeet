import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const pluginRoot = path.join(repoRoot, 'IDE-plugins/webmeet-tool-button');

test('WebMeet dashboard is a page component and settings is a WebSkel modal', async () => {
    const config = JSON.parse(await fs.readFile(path.join(pluginRoot, 'config.json'), 'utf8'));
    const dashboard = config.dependencies.find((entry) => entry.component === 'webmeet-dashboard');
    const settingsModal = config.dependencies.find((entry) => entry.component === 'webmeet-settings-modal');

    assert.ok(dashboard);
    assert.equal(dashboard.presenter, 'WebmeetDashboard');
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
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
        'utf8'
    );

    assert.match(modalSource, /ensureResizable\(\)/);
    assert.match(modalSource, /toggleFullscreen\(\)/);
    assert.match(modalSource, /webmeet:settings-modal-action/);
    assert.match(modalCss, /\.webmeet-settings-modal-content \.webmeet-hidden/);
    assert.match(modalCss, /\.webmeet-settings-resize-handle\.se/);
    assert.match(modalCss, /webmeet-settings-modal-dialog\.is-fullscreen/);
    const dialogRule = modalCss.match(/dialog\.modal\.webmeet-settings-modal-dialog\s*\{[^}]*\}/)?.[0] || '';
    const wrapperRule = modalCss.match(/\.webmeet-settings-modal\s*\{[^}]*\}/)?.[0] || '';
    const contentPanelRule = modalCss.match(/\.webmeet-settings-modal-content \.webmeet-media-settings\s*\{[^}]*\}/)?.[0] || '';
    assert.doesNotMatch(dialogRule, /background: transparent/);
    assert.doesNotMatch(dialogRule, /border: none/);
    assert.doesNotMatch(wrapperRule, /background: var\(--surface\)/);
    assert.doesNotMatch(wrapperRule, /border: 1px solid var\(--border\)/);
    assert.match(contentPanelRule, /background: transparent/);
    assert.match(contentPanelRule, /box-shadow: none/);
    assert.match(dashboardSource, /showModal\?\.\('webmeet-settings-modal'\)/);
    assert.match(dashboardSource, /mountMediaSettingsModal/);
    assert.match(dashboardSource, /restoreMediaSettingsPanel/);
});

test('WebMeet close buttons use the shared modal icon asset from ui-common', async () => {
    const htmlFiles = [
        'components/create-room-modal/create-room-modal.html',
        'components/webmeet-dashboard/webmeet-dashboard.html',
        'components/webmeet-participant-audio-modal/webmeet-participant-audio-modal.html',
        'components/webmeet-room-settings-modal/webmeet-room-settings-modal.html'
    ];
    const commonCss = await fs.readFile(path.join(repoRoot, '../explorer/shared/ui/ui-common.css'), 'utf8');

    assert.match(commonCss, /\.close:empty::before\s*\{[\s\S]*\/explorer\/assets\/icons\/x-mark\.svg/);
    for (const file of htmlFiles) {
        const source = await fs.readFile(path.join(pluginRoot, file), 'utf8');
        assert.doesNotMatch(source, /close-icon/);
        assert.doesNotMatch(source, /x-mark\.svg/);
        assert.doesNotMatch(source, /class="close"[\s\S]{0,160}<svg/);
        assert.doesNotMatch(source, /class="close"[\s\S]{0,160}<img/);
    }
});

test('WebMeet settings tab footer actions hide inactive tab controls inside the modal', async () => {
    const dashboardHtml = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const mediaSettingsSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/controllers/media-settings-methods.js'),
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
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.html'),
        'utf8'
    );
    const dashboardCss = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.css'),
        'utf8'
    );
    const dashboardSource = await fs.readFile(
        path.join(pluginRoot, 'components/webmeet-dashboard/webmeet-dashboard.js'),
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
