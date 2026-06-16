import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    getMeeting,
    getRoomBlackboard,
    getRoboTeamSettings,
    listMeetingAgents,
    updateRoboTeamSettings
} from '../../lib/webmeetStore.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord
} from '../../lib/store/roomRecords.mjs';

async function withStore(fn) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-robo-team-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.ploinky', 'webmeet');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });
    try {
        return await fn(await createStoreContext(root));
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('new rooms default RoboTeam to active with blackboard demo widgets', async () => {
    await withStore(async (context) => {
        const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const meeting = await createMeeting(context, { name: 'RoboTeam defaults', authInfo });

        const settingsResponse = await getRoboTeamSettings(context, { roomId: meeting.roomId, authInfo });
        const agents = await listMeetingAgents(context, meeting.roomId, authInfo);
        const blackboard = await getRoomBlackboard(context, { roomId: meeting.roomId, authInfo });
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        const roboTeam = payload.agents.find((agent) => agent.id === 'agent_robo_team');

        assert.equal(settingsResponse.settings.assistant.name, 'Robo Team');
        assert.equal(settingsResponse.settings.blackboard.enabled, true);
        assert.equal(settingsResponse.settings.blackboard.visibility, 'all-participants');
        assert.equal(settingsResponse.settings.blackboard.autoUpdateFromConversation, true);
        assert.equal(settingsResponse.settings.blackboard.participantRequestsEnabled, true);
        assert.ok(agents.some((agent) => agent.agentType === 'robo_team' && agent.runtime === 'ploinky'));
        assert.equal(payload.blackboard, undefined);
        assert.ok(roboTeam.blackboard.widgets.some((widget) => widget.id === 'robo_demo_quiz'));
        assert.ok(blackboard.blackboard.widgets.some((widget) => widget.id === 'robo_demo_quiz'));
    });
});

test('RoboTeam settings persist and RoboTeam is projected as a room participant', async () => {
    await withStore(async (context) => {
        const authInfo = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const meeting = await createMeeting(context, { name: 'RoboTeam projection', authInfo });

        await updateRoboTeamSettings(context, {
            roomId: meeting.roomId,
            authInfo,
            settings: {
                assistant: { name: 'Robo Team Demo' },
                blackboard: {
                    enabled: true,
                    visibility: 'all-participants',
                    autoUpdateFromConversation: true,
                    participantRequestsEnabled: true
                }
            }
        });

        const details = await getMeeting(context, meeting.roomId, authInfo, { includeParticipants: false });
        const participant = details.participants.find((entry) => entry.kind === 'agent' && entry.id === 'agent_robo_team');

        assert.equal(participant.displayName, 'Robo Team Demo');
        assert.equal(participant.attributes.webmeetAgentType, 'robo_team');
        assert.equal(participant.attributes.webmeetAgentRuntime, 'ploinky');
    });
});

test('RoboTeam agent list hides full settings from non-admin viewers', async () => {
    await withStore(async (context) => {
        const adminAuth = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
        const viewerAuth = { user: { id: 'local:user-1', username: 'user1', roles: ['user'] } };
        const meeting = await createMeeting(context, { name: 'RoboTeam public projection', authInfo: adminAuth });

        const adminAgents = await listMeetingAgents(context, meeting.roomId, adminAuth);
        const viewerAgents = await listMeetingAgents(context, meeting.roomId, viewerAuth);
        const adminRoboTeam = adminAgents.find((agent) => agent.agentType === 'robo_team');
        const viewerRoboTeam = viewerAgents.find((agent) => agent.agentType === 'robo_team');

        assert.ok(adminRoboTeam?.settings?.blackboard);
        assert.equal(viewerRoboTeam.agentName, 'Robo Team');
        assert.equal(viewerRoboTeam.runtime, 'ploinky');
        assert.equal(viewerRoboTeam.settings, undefined);
    });
});
