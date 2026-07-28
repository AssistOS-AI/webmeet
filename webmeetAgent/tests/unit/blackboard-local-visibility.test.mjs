import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { blackboardMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/blackboard-methods.js';
import { participantViewMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js';

function roboCardTarget() {
    return {
        dataset: { participantId: 'agent_robo_team' },
        closest() { return null; },
    };
}

test('selecting the RoboTeam card opens and closes blackboard only in the current dashboard', async () => {
    const applied = [];
    const published = [];
    let collapsed = 0;
    let layoutRenders = 0;
    const dashboard = {
        state: {
            selectedMeetingId: 'room-1',
            session: {
                meeting: { id: 'room-1' },
                participantIdentity: 'participant-1',
            },
            blackboard: { visible: false },
            agents: [],
        },
        participantLayoutController: {
            getParticipantView: () => ({ id: 'agent_robo_team' }),
            renderParticipantLayout: () => { layoutRenders += 1; },
        },
        applyBlackboardVisibility: async (payload) => {
            applied.push(payload);
            dashboard.state.blackboard.visible = payload.visible === true;
        },
        publishRealtimePayload: async (payload) => { published.push(payload); },
        collapseBlackboardFocus: () => {
            collapsed += 1;
            dashboard.state.blackboard.visible = false;
        },
        setError: (message) => { throw new Error(message); },
    };

    await participantViewMethods.focusParticipantCard.call(dashboard, roboCardTarget());
    assert.equal(applied.length, 1);
    assert.equal(applied[0].visible, true);
    assert.deepEqual(published, []);

    await participantViewMethods.focusParticipantCard.call(dashboard, roboCardTarget());
    assert.equal(collapsed, 1);
    assert.equal(layoutRenders, 1);
    assert.deepEqual(published, []);
});

test('the Blackboard toolbar toggle changes only local dashboard state', async () => {
    let applied = null;
    let collapsed = 0;
    let layoutRenders = 0;
    const dashboard = Object.assign({}, blackboardMethods, {
        state: {
            selectedMeetingId: 'room-1',
            session: { participantIdentity: 'participant-1' },
            blackboard: { visible: false },
        },
        room: { localParticipant: { identity: 'participant-1' } },
        participantLayoutController: {
            renderParticipantLayout: () => { layoutRenders += 1; },
        },
        applyBlackboardVisibility: async (payload) => {
            applied = payload;
            dashboard.state.blackboard.visible = payload.visible === true;
        },
        collapseBlackboardFocus: () => {
            collapsed += 1;
            dashboard.state.blackboard.visible = false;
        },
        ensureBlackboardAdapter: () => { throw new Error('Local visibility must not call the server.'); },
        setError: (message) => { throw new Error(message); },
    });

    await dashboard.toggleBlackboard();
    assert.equal(applied.visible, true);
    assert.equal(applied.presenterId, 'agent_robo_team');

    await dashboard.toggleBlackboard();
    assert.equal(collapsed, 1);
    assert.equal(layoutRenders, 1);
});

test('a chat image upload opens the uploader local Blackboard and applies its projection', async () => {
    const applied = [];
    const projections = [];
    const dashboard = Object.assign({}, blackboardMethods, {
        state: {
            session: { participantIdentity: 'participant-1' },
            blackboard: { visible: false },
        },
        selectedMeeting: { id: 'room-1' },
        applyBlackboardVisibility: async (payload) => {
            applied.push(payload);
            dashboard.state.blackboard.visible = payload.visible === true;
        },
        ensureBlackboardAdapter: async () => ({
            applyBlackboardProjection: (projection, options) => projections.push({ projection, options }),
        }),
    });
    const blackboard = { revision: 7, widgets: [{ id: 'image-1', type: 'image' }] };

    await dashboard.refreshChatBlackboard({ blackboard }, { ensureVisible: true });

    assert.equal(applied.length, 1);
    assert.equal(applied[0].visible, true);
    assert.equal(applied[0].participantId, 'participant-1');
    assert.equal(applied[0].presenterId, 'agent_robo_team');
    assert.deepEqual(projections, [{
        projection: blackboard,
        options: { reason: 'command-result' },
    }]);
});

test('remote blackboard visibility events are not bound to local dashboard visibility', async () => {
    const source = await fs.readFile(new URL(
        '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-realtime-methods.js',
        import.meta.url
    ), 'utf8');
    assert.doesNotMatch(source, /ROOM_EVENT_TYPES\.BLACKBOARD_VISIBILITY_CHANGED/);
});
