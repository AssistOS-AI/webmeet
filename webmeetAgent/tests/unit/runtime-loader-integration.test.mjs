import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { dashboardSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js';

const dashboardRoot = path.resolve(
    import.meta.dirname,
    '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard'
);
const toolButtonPath = path.resolve(
    import.meta.dirname,
    '../../IDE-plugins/webmeet-tool-button/webmeet-tool-button.js'
);
const sharedRuntimeLoaderPath = path.resolve(
    import.meta.dirname,
    '../../../explorer/shared/ui/agent-runtime-loader/agent-runtime-loader.js'
);
const explorerMainPath = path.resolve(import.meta.dirname, '../../../explorer/main.js');
const explorerIndexPath = path.resolve(import.meta.dirname, '../../../explorer/index.html');

test('WebMeet shows the runtime loader only after an actual startup failure', () => {
    const source = fs.readFileSync(path.join(dashboardRoot, 'webmeet-dashboard.js'), 'utf8');
    const template = fs.readFileSync(path.join(dashboardRoot, 'webmeet-dashboard.html'), 'utf8');
    assert.match(source, /\/explorer\/shared\/ui\/agent-runtime-loader\/agent-runtime-loader\.js/);
    assert.match(source, /await this\.loadInitialDashboardData\?\.\(\{ reportError: false \}\)/);
    assert.match(source, /if \(!isAgentRuntimeStartupError\(error\)\)/);
    assert.match(source, /classList\.add\('webmeet-runtime-pending'\)/);
    assert.match(source, /mountAgentRuntimeLoader\(host,/);
    assert.match(source, /operation: \(\) => this\.loadInitialDashboardData\?\.\(\{ reportError: false \}\)/);
    assert.match(template, /data-role="runtime-loader"/);
    assert.doesNotMatch(template, /webmeet-dashboard webmeet-runtime-pending/);
});

test('Explorer WebMeet launch opens the runtime wait route before roomLoader', () => {
    const source = fs.readFileSync(toolButtonPath, 'utf8');
    assert.match(source, /buildAgentRuntimeWaitUrl/);
    assert.match(source, /agentRef: `AchillesIDE\/\$\{this\.getWebMeetAgentName\(\)\}`/);
    assert.match(source, /window\.open\(waitingUrl\.toString\(\), '_blank', 'noopener'\)/);
    assert.doesNotMatch(source, /window\.open\(targetUrl\.toString\(\), '_blank', 'noopener'\)/);
});

test('Explorer keeps one bootstrap loader for the complete WebMeet wait', () => {
    const source = fs.readFileSync(explorerMainPath, 'utf8');
    const template = fs.readFileSync(explorerIndexPath, 'utf8');
    const waitBranch = source.indexOf('await waitForInitialAgentRuntime(runtimeWaitRoute)');
    const webSkelBootstrap = source.indexOf("await WebSkel.initialise('webskel.json')");

    assert.ok(waitBranch >= 0);
    assert.ok(webSkelBootstrap > waitBranch);
    assert.match(source, /await probeAgentRuntimeTarget\(route\.targetUrl\)/);
    assert.match(source, /await probeAgentRuntimeMcp\(route\.agentRef, assistosSDK\)/);
    assert.match(source, /await probeAgentRuntimeRouteStability\(route\.agentRef\)/);
    assert.match(template, /data-role="runtime-retry" hidden/);
});

test('initial dashboard loading exposes startup failures only to the conditional loader', async () => {
    const startupError = Object.assign(new Error('WebMeet is still starting.'), { status: 503 });
    const errors = [];
    const dashboard = {
        initialRoomId: '',
        loadMeetings: async () => {
            throw startupError;
        },
        setError: (message) => errors.push(message)
    };

    await assert.rejects(
        () => dashboardSessionMethods.loadInitialDashboardData.call(dashboard, { reportError: false }),
        (error) => error === startupError
    );
    assert.deepEqual(errors, []);

    await dashboardSessionMethods.loadInitialDashboardData.call(dashboard);
    assert.deepEqual(errors, ['WebMeet is still starting.']);
});

test('public WebMeet can load the shared runtime component without protected Explorer modules', () => {
    const source = fs.readFileSync(sharedRuntimeLoaderPath, 'utf8');
    assert.match(source, /from '\.\.\/runtime-component-registration\.js'/);
    assert.doesNotMatch(source, /explorer\/utils|pluginUtils\.ui/);
});
