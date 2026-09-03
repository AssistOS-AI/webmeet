import assert from 'node:assert/strict';
import test from 'node:test';

import { WebMeetToolButton } from '../../IDE-plugins/webmeet-tool-button/webmeet-tool-button.js';
import { dashboardSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-session-methods.js';

function setBrowserContext(t, overrides = {}) {
    for (const [key, value] of Object.entries({
        window: { location: new URL('https://workspace.example/explorer/index.html') },
        __WEBMEET_INITIAL_ROOM_ID__: '',
        __WEBMEET_GUEST_ENTRY__: false,
        ...overrides,
    })) {
        const previous = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => {
            if (previous) {
                Object.defineProperty(globalThis, key, previous);
            } else {
                delete globalThis[key];
            }
        });
    }
}

for (const { name, context, attribute, expectedPath } of [
    { name: 'default agent', expectedPath: '/webmeetAgent/roomLoader.html' },
    { name: 'plugin agent alias', context: { pluginAgent: 'meeting-test' }, expectedPath: '/meeting-test/roomLoader.html' },
    { name: 'host agent alias', context: { agent: 'meeting-host' }, expectedPath: '/meeting-host/roomLoader.html' },
    { name: 'element agent alias', attribute: 'meeting-element', expectedPath: '/meeting-element/roomLoader.html' },
    { name: 'blank alias', context: { pluginAgent: '  ' }, expectedPath: '/webmeetAgent/roomLoader.html' },
    { name: 'alias containing URL delimiters', context: { pluginAgent: 'team/meet?#' }, expectedPath: '/team%2Fmeet%3F%23/roomLoader.html' },
]) {
    test(`WebMeet toolbar directly opens the room loader for ${name}`, (t) => {
        const opened = [];
        const calls = [];
        setBrowserContext(t, {
            window: {
                location: new URL('https://workspace.example/explorer/index.html#workspace'),
                open: (...args) => opened.push(args),
            },
        });
        const button = new WebMeetToolButton({
            getAttribute: (key) => key === 'data-plugin-agent' ? attribute || null : null,
        }, () => {});
        button.updateHostContext(context);
        button.scheduleInitialTabLoaderCleanup = () => calls.push('cleanup');

        button.openDashboard({
            preventDefault: () => calls.push('preventDefault'),
            stopPropagation: () => calls.push('stopPropagation'),
        });

        assert.deepEqual(opened, [[`https://workspace.example${expectedPath}`, '_blank', 'noopener']]);
        assert.deepEqual(calls, ['preventDefault', 'stopPropagation', 'cleanup']);
    });
}

for (const status of [401, 500, 503]) {
    test(`initial dashboard ${status} failures use ordinary error reporting`, async (t) => {
        setBrowserContext(t);
        const errors = [];
        let attempts = 0;
        const failure = Object.assign(new Error(`Room loading failed (${status}).`), { status });
        const dashboard = {
            initialRoomId: '',
            loadMeetings: async () => {
                attempts += 1;
                throw failure;
            },
            startWorkspaceEvents: () => assert.fail('Workspace events must wait for room loading.'),
            renderAll: () => assert.fail('A failed room list must not be treated as loaded.'),
            setError: (message) => errors.push(message),
        };

        await dashboardSessionMethods.loadInitialDashboardData.call(dashboard);

        assert.equal(attempts, 1);
        assert.deepEqual(errors, [failure.message]);
    });
}

test('initial dashboard room loading starts workspace events and renders the room list', async (t) => {
    setBrowserContext(t);
    const calls = [];
    const dashboard = {
        initialRoomId: '',
        loadMeetings: async () => calls.push('loadMeetings'),
        startWorkspaceEvents: () => calls.push('startWorkspaceEvents'),
        renderAll: () => calls.push('renderAll'),
        setError: (message) => assert.fail(message),
    };

    await dashboardSessionMethods.loadInitialDashboardData.call(dashboard);

    assert.deepEqual(calls, ['loadMeetings', 'startWorkspaceEvents', 'renderAll']);
});

test('initial guest dashboard prepares only the linked room', async (t) => {
    setBrowserContext(t, { __WEBMEET_GUEST_ENTRY__: true });
    const roomIds = [];
    const dashboard = {
        initialRoomId: 'invited-room',
        prepareGuestRoomEntry: async (roomId) => roomIds.push(roomId),
        loadMeetings: () => assert.fail('Guest entry must not load workspace rooms.'),
        setError: (message) => assert.fail(message),
    };

    await dashboardSessionMethods.loadInitialDashboardData.call(dashboard);

    assert.deepEqual(roomIds, ['invited-room']);
});
