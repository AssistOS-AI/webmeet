import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { roomSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setBrowserGlobals() {
    const browserWindow = new EventTarget();
    browserWindow.setTimeout = globalThis.setTimeout.bind(globalThis);
    browserWindow.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    const connection = new EventTarget();
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: browserWindow
    });
    Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: { onLine: true, connection }
    });
    return { browserWindow, connection };
}

function restoreGlobal(name, descriptor) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete globalThis[name];
}

afterEach(() => {
    restoreGlobal('window', originalWindowDescriptor);
    restoreGlobal('navigator', originalNavigatorDescriptor);
});

test('network refresh listeners are exact and removed when the dashboard unloads', async () => {
    const { browserWindow, connection } = setBrowserGlobals();
    const reasons = [];
    const presenter = {
        roomLiveKit: { getRoom: () => ({ connected: true }) },
        refreshJoinMaterialAndReconnect: async (reason) => reasons.push(reason),
        joinMaterialRefreshTimer: browserWindow.setTimeout(() => {}, 60_000),
        joinMaterialNetworkRefreshHandler: null
    };

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    connection.dispatchEvent(new Event('change'));
    await Promise.resolve();
    assert.deepEqual(reasons, ['network-transition', 'network-transition']);

    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
    assert.equal(presenter.joinMaterialNetworkRefreshHandler, null);
    assert.equal(presenter.joinMaterialRefreshTimer, null);
    browserWindow.dispatchEvent(new Event('online'));
    connection.dispatchEvent(new Event('change'));
    await Promise.resolve();
    assert.deepEqual(reasons, ['network-transition', 'network-transition']);
});

test('credential refresh recreates the room without attempting non-activated display capture', async () => {
    setBrowserGlobals();
    const calls = [];
    const presenter = {
        state: {
            session: { participantIdentity: 'participant-a' },
            media: { microphone: true, camera: true, screen: true },
            roomState: 'Connected'
        },
        joinMaterialRefreshInFlight: false,
        webMeetRoom: {
            async refreshJoinMaterial() {
                calls.push('fresh-join-material');
            }
        },
        async disconnectRoom(options) {
            calls.push(['disconnect', options]);
            this.state.media = { microphone: false, camera: false, screen: false };
        },
        async connectRoom() {
            calls.push('connect');
        },
        async toggleMicrophone() {
            calls.push('microphone');
            this.state.media.microphone = true;
        },
        async toggleCamera() {
            calls.push('camera');
            this.state.media.camera = true;
        },
        async toggleScreenShare() {
            throw new Error('screen capture must require a new user activation');
        },
        setError(message) {
            calls.push(['notice', message]);
        },
        renderMeetingSummary() {
            calls.push('render');
        }
    };

    await roomSessionMethods.refreshJoinMaterialAndReconnect.call(presenter, 'credential-expiry');

    assert.deepEqual(calls.slice(0, 5), [
        'fresh-join-material',
        ['disconnect', { stopMediaFirst: false }],
        'connect',
        'microphone',
        'camera'
    ]);
    assert.equal(calls.includes('screen'), false);
    assert.match(presenter.state.roomState, /Share screen to resume/);
    assert.equal(presenter.joinMaterialRefreshInFlight, false);
});
