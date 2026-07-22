import test from 'node:test';
import assert from 'node:assert/strict';

import { blackboardMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
    isPersistentWebMeetEvent,
    parseWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

function makeDashboard() {
    const panelEvents = [];
    const published = [];
    return Object.assign({
        state: {
            selectedMeetingId: 'meeting-1',
            session: {
                participantIdentity: 'participant-1',
                participant: { displayName: 'User One' },
            },
            participants: [{ identity: 'participant-1', displayName: 'User One' }],
        },
        room: null,
        roboCommandStatuses: new Map(),
        roboCommandStatusTimers: new Map(),
        roboCommandDraftActive: false,
        blackboardCommandStatus: null,
        blackboardPanel: {
            dispatchEvent(event) { panelEvents.push(event.detail); }
        },
        async publishRealtimePayload(payload) { published.push(payload); },
        panelEvents,
        published,
    }, blackboardMethods);
}

test('Robo command status controls ordinal mode and terminal durations', async () => {
    const dashboard = makeDashboard();
    const durations = [];
    const previousSetTimeout = globalThis.setTimeout;
    const previousClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = (_callback, duration) => {
        durations.push(duration);
        return durations.length;
    };
    globalThis.clearTimeout = () => {};
    try {
        await dashboard.updateRoboCommandStatus({
            commandId: 'command-1', participantId: 'participant-1', state: 'started'
        }, { publish: true });
        assert.equal(dashboard.panelEvents.at(-1).active, true);
        assert.equal(durations.at(-1), 75_000);
        assert.equal(dashboard.published[0].type, WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS);

        await dashboard.updateRoboCommandStatus({
            commandId: 'command-1', participantId: 'participant-1', state: 'success'
        });
        assert.equal(dashboard.panelEvents.at(-1).active, false);
        assert.equal(durations.at(-1), 4_000);

        await dashboard.updateRoboCommandStatus({
            commandId: 'command-2', participantId: 'participant-1', state: 'error', errorMessage: 'Ambiguous target.'
        });
        assert.equal(durations.at(-1), 10_000);
        assert.equal(dashboard.roboCommandStatuses.get('command-2').errorMessage, 'Ambiguous target.');
    } finally {
        globalThis.setTimeout = previousSetTimeout;
        globalThis.clearTimeout = previousClearTimeout;
    }
});

test('a typed /robo draft activates ordinals without showing execution status', () => {
    const dashboard = makeDashboard();
    dashboard.setRoboCommandDraftActive(true);
    assert.equal(dashboard.panelEvents.at(-1).active, true);
    assert.equal(dashboard.roboCommandStatuses.size, 0);

    dashboard.setRoboCommandDraftActive(false);
    assert.equal(dashboard.panelEvents.at(-1).active, false);
});

test('blackboard command status is validated as realtime-only', () => {
    const encoded = buildWebMeetEvent('meeting-1', WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS, {
        meetingId: 'meeting-1', boardId: 'agent:agent_robo_team', commandId: 'command-1',
        participantId: 'participant-1', state: 'error', errorMessage: 'Ambiguous target.'
    });
    assert.equal(parseWebMeetEvent(encoded).payload.state, 'error');
    assert.equal(isPersistentWebMeetEvent(WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS), false);
    assert.throws(() => buildWebMeetEvent('meeting-1', WEBMEET_EVENT_TYPES.BLACKBOARD_COMMAND_STATUS, {
        meetingId: 'meeting-1', boardId: 'agent:agent_robo_team', commandId: 'command-1',
        participantId: 'participant-1', state: 'waiting'
    }), /Invalid blackboard command status state/);
});
