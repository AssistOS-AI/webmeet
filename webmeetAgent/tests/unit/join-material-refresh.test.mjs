import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { roomSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/room-session-methods.js';

const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setBrowserGlobals() {
    const browserWindow = new EventTarget();
    browserWindow.setTimeout = globalThis.setTimeout.bind(globalThis);
    browserWindow.clearTimeout = globalThis.clearTimeout.bind(globalThis);
    browserWindow.setInterval = globalThis.setInterval.bind(globalThis);
    browserWindow.clearInterval = globalThis.clearInterval.bind(globalThis);
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

const RELAY_ICE_SERVERS = [{
    urls: 'turn:turn.example:3478',
    username: 'temporary',
    credential: 'secret'
}];

function createNetworkPresenter(browserWindow, { iceServers = RELAY_ICE_SERVERS, roomState = 'connected' } = {}) {
    const reasons = [];
    const room = { state: roomState };
    const presenter = {
        state: { session: { rtcConfig: { iceTransportPolicy: 'all', iceServers } } },
        roomLiveKit: { getRoom: () => room },
        refreshJoinMaterialAndReconnect: async (reason) => reasons.push(reason),
        joinMaterialRefreshTimer: browserWindow.setTimeout(() => {}, 60_000),
        joinMaterialNetworkRefreshHandler: null
    };
    return { presenter, reasons, room };
}

test('direct-UDP sessions leave network transitions to the LiveKit resume', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow, connection } = setBrowserGlobals();
    const { presenter, reasons } = createNetworkPresenter(browserWindow, { iceServers: [], roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    assert.equal(presenter.joinMaterialNetworkRefreshHandler ?? null, null);
    browserWindow.dispatchEvent(new Event('online'));
    connection.dispatchEvent(new Event('change'));
    t.mock.timers.tick(60_000);
    assert.deepEqual(reasons, []);
});

test('network quality estimate changes never recreate a relay session', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow, connection } = setBrowserGlobals();
    const { presenter, reasons } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    connection.dispatchEvent(new Event('change'));
    t.mock.timers.tick(60_000);
    assert.deepEqual(reasons, []);
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
});

test('relay sessions that LiveKit resumed in the grace period are kept', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow } = setBrowserGlobals();
    const { presenter, reasons, room } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    room.state = 'connected';
    t.mock.timers.tick(15_000);
    assert.deepEqual(reasons, []);
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
});

test('relay sessions still resuming after the grace period recreate join material once', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow } = setBrowserGlobals();
    const { presenter, reasons, room } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    t.mock.timers.tick(5_000);
    room.state = 'signalReconnecting';
    browserWindow.dispatchEvent(new Event('online'));
    t.mock.timers.tick(14_999);
    assert.deepEqual(reasons, []);
    t.mock.timers.tick(1);
    assert.deepEqual(reasons, ['network-transition']);
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
});

test('relay sessions that LiveKit disconnected are not rejoined by the network check', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow } = setBrowserGlobals();
    const { presenter, reasons, room } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    room.state = 'disconnected';
    t.mock.timers.tick(15_000);
    assert.deepEqual(reasons, []);
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
});

test('relay listeners do not recreate sessions whose join material lost its relay servers', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow } = setBrowserGlobals();
    const { presenter, reasons } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    presenter.state.session = { rtcConfig: { iceTransportPolicy: 'all', iceServers: [] } };
    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    t.mock.timers.tick(15_000);
    assert.deepEqual(reasons, []);
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
});

test('network refresh listeners and pending checks are removed when the dashboard unloads', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { browserWindow } = setBrowserGlobals();
    const { presenter, reasons } = createNetworkPresenter(browserWindow, { roomState: 'reconnecting' });

    roomSessionMethods.installJoinMaterialRefreshListeners.call(presenter);
    browserWindow.dispatchEvent(new Event('online'));
    roomSessionMethods.uninstallJoinMaterialRefreshListeners.call(presenter);
    assert.equal(presenter.joinMaterialNetworkRefreshHandler, null);
    assert.equal(presenter.joinMaterialNetworkCheckTimer, null);
    assert.equal(presenter.joinMaterialRefreshTimer, null);
    t.mock.timers.tick(60_000);
    browserWindow.dispatchEvent(new Event('online'));
    t.mock.timers.tick(60_000);
    assert.deepEqual(reasons, []);
});

test('connected room starts edge refresh and Meeting Notes transcription together', () => {
    const source = roomSessionMethods.connectRoom.toString();
    assert.match(source, /onConnected:[\s\S]*installJoinMaterialRefreshListeners\(\)[\s\S]*scheduleJoinMaterialRefresh\(\)[\s\S]*meetingNotesTranscription\?\.sync/);
});

test('room UI reset handles the explicit session cleanup option', () => {
    setBrowserGlobals();
    const presenter = {
        roomLiveKit: { getRoom: () => null },
        mediaController: { reset() {} },
        state: {
            session: { meeting: { id: 'room-1' } },
            media: {},
            mediaLoading: {},
        },
        resetBlackboardUiState() {},
        meetingNotesTranscription: { sync() {} },
        remoteAudioNormalizer: { stopAll() {} },
        participantLayoutController: { clearAll() {} },
        renderMeetingSummary() {},
        renderFeedLists() {},
    };

    roomSessionMethods.resetRoomUiState.call(presenter, { clearSession: true });

    assert.equal(presenter.state.session, null);
});

test('local direct-UDP sessions do not schedule TURN credential refresh', () => {
    setBrowserGlobals();
    const presenter = {
        state: {
            session: {
                rtcConfig: {
                    iceTransportPolicy: 'all',
                    iceServers: []
                }
            }
        },
        joinMaterialRefreshTimer: globalThis.setTimeout(() => {}, 60_000)
    };

    roomSessionMethods.scheduleJoinMaterialRefresh.call(presenter);

    assert.equal(presenter.joinMaterialRefreshTimer, null);
});

test('TURN sessions still require an exact credential expiry', () => {
    setBrowserGlobals();
    const presenter = {
        state: {
            session: {
                rtcConfig: {
                    iceTransportPolicy: 'all',
                    iceServers: [{
                        urls: 'turn:turn.example:3478',
                        username: 'temporary',
                        credential: 'secret'
                    }]
                }
            }
        },
        joinMaterialRefreshTimer: null
    };

    assert.throws(
        () => roomSessionMethods.scheduleJoinMaterialRefresh.call(presenter),
        /missing a valid TURN expiry/
    );
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
