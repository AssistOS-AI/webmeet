import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    createMeeting,
    createStoreContext,
    createWorkspace,
    getMeeting,
    joinGuestMeeting,
    joinMeeting,
    listWorkspaceEvents,
    recordProfileAvatarUpdated,
    updateMeetingParticipantAvatar
} from '../../lib/webmeetStore.mjs';

let tempRoot = '';
const originalDataDir = process.env.WEBMEET_DATA_DIR;
const originalMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
const originalLivekitApiKey = process.env.WEBMEET_LIVEKIT_API_KEY;
const originalLivekitApiSecret = process.env.WEBMEET_LIVEKIT_API_SECRET;

beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'webmeet-avatar-events-'));
    process.env.WEBMEET_DATA_DIR = path.join(tempRoot, 'data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    process.env.WEBMEET_LIVEKIT_API_KEY = 'devkey';
    process.env.WEBMEET_LIVEKIT_API_SECRET = 'devsecret';
});

afterEach(() => {
    if (originalDataDir === undefined) {
        delete process.env.WEBMEET_DATA_DIR;
    } else {
        process.env.WEBMEET_DATA_DIR = originalDataDir;
    }
    if (originalMasterKey === undefined) {
        delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
    } else {
        process.env.PLOINKY_WEBMEET_MASTER_KEY = originalMasterKey;
    }
    if (originalLivekitApiKey === undefined) {
        delete process.env.WEBMEET_LIVEKIT_API_KEY;
    } else {
        process.env.WEBMEET_LIVEKIT_API_KEY = originalLivekitApiKey;
    }
    if (originalLivekitApiSecret === undefined) {
        delete process.env.WEBMEET_LIVEKIT_API_SECRET;
    } else {
        process.env.WEBMEET_LIVEKIT_API_SECRET = originalLivekitApiSecret;
    }
    if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
        tempRoot = '';
    }
});

function setLiveKitParticipants(context, participants) {
    context.listLiveKitParticipants = async () => participants;
}

function liveKitParticipant(identity, name, attributes = {}) {
    return {
        identity,
        name,
        kind: 'STANDARD',
        attributes
    };
}

test('profile avatar updates are published as workspace events', () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };

    const event = recordProfileAvatarUpdated(context, {
        workspaceId: workspace.id,
        userId: 'local:admin',
        authInfo
    });

    assert.equal(event.type, 'profile.avatar.updated');
    assert.equal(event.payload.userId, 'local:admin');

    const events = listWorkspaceEvents(context, workspace.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'profile.avatar.updated');
    assert.equal(events[0].payload.workspaceId, workspace.id);
    assert.equal(events[0].payload.userId, 'local:admin');
});

test('authenticated event list tools are exposed through MCP config and dispatch', () => {
    const mcpConfig = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../mcp-config.json'),
        'utf8'
    );
    assert.match(mcpConfig, /"name": "webmeet_workspace_events_list"/);
    assert.match(mcpConfig, /"name": "webmeet_meeting_events_list"/);

    const toolSource = fs.readFileSync(
        path.resolve(import.meta.dirname, '../../tools/webmeet_tool.mjs'),
        'utf8'
    );
    assert.match(toolSource, /case 'webmeet_workspace_events_list'/);
    assert.match(toolSource, /listWorkspaceEvents\(context, getRequiredString\(args, 'workspaceId'\)/);
    assert.match(toolSource, /case 'webmeet_meeting_events_list'/);
    assert.match(toolSource, /listMeetingEvents\(context, getRequiredString\(args, 'meetingId'\)/);
});

test('join publishes workspace user id in participant state and LiveKit token attributes', () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:user-one',
            username: 'user-one',
            roles: []
        }
    };
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar room',
        authInfo: adminAuthInfo
    });

    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'User One',
        participantId: 'participant-user-one',
        authInfo
    });

    assert.equal(session.participant.userId, 'local:user-one');
    assert.equal(session.participant.attributes.webmeetUserId, 'local:user-one');

    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes.webmeetUserId, 'local:user-one');
    assert.equal(jwtPayload.attributes.workspaceUserId, 'local:user-one');
    assert.equal(jwtPayload.attributes.ploinkyUserId, 'local:user-one');
});

test('participant avatar projection is stored on the meeting roster', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar projection room',
        authInfo
    });
    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin',
        authInfo
    });

    const updated = updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                size: '48',
                seed: 'profile:local:admin',
                style: 'robot-soft',
                palette: 'terminal'
            }
        },
        authInfo
    });

    assert.equal(updated.profileAvatar.enabled, true);
    assert.equal(updated.profileAvatar.config.size, '48');
    assert.equal(updated.profileAvatar.config.palette, 'terminal');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.seed, 'profile:local:admin');

    const events = listWorkspaceEvents(context, workspace.id);
    assert.equal(
        events.some((event) => (
            event.type === 'participant.avatar.updated'
            && event.payload?.participantId === session.participantIdentity
        )),
        true
    );
});

test('participant avatar projection rejects unsafe or invalid config fields', () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar validation room',
        authInfo
    });
    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-validation',
        authInfo
    });

    assert.throws(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                src: 'javascript:alert(1)',
                generated: false
            }
        },
        authInfo
    }), /unsafe URL scheme/);

    assert.throws(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                emotion: 'surprised'
            }
        },
        authInfo
    }), /Invalid participant avatar emotion/);

    assert.throws(() => updateMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:admin',
                onload: 'alert(1)'
            }
        },
        authInfo
    }), /Unknown participant avatar config field/);
});

test('join can persist avatar projection for a freshly created participant id', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Avatar join projection room',
        authInfo
    });

    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-rejoin',
        avatar: {
            enabled: true,
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                size: '48',
                seed: 'profile:local:admin',
                style: 'robot-soft',
                palette: 'terminal'
            }
        },
        authInfo
    });

    assert.equal(session.participant.profileAvatar.enabled, true);
    assert.equal(session.participant.profileAvatar.config.seed, 'profile:local:admin');
    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    const tokenAvatar = JSON.parse(jwtPayload.attributes.webmeetProfileAvatar);
    assert.equal(tokenAvatar.config.seed, 'profile:local:admin');
    assert.equal(tokenAvatar.config.size, '48');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.seed, 'profile:local:admin');

    const events = listWorkspaceEvents(context, workspace.id);
    assert.equal(
        events.some((event) => (
            event.type === 'participant.avatar.updated'
            && event.payload?.participantId === session.participantIdentity
        )),
        true
    );
});

test('join fills a generated avatar config when authenticated profile payload has no config', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const authInfo = {
        user: {
            id: 'local:user',
            username: 'user',
            roles: ['user']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Default avatar projection room',
        authInfo: adminAuthInfo
    });

    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'User',
        participantId: 'participant-user-default-avatar',
        avatar: {
            enabled: true,
            fallbackLetter: 'U',
            config: null
        },
        authInfo
    });

    assert.equal(session.participant.profileAvatar.enabled, true);
    assert.equal(session.participant.profileAvatar.config.agentId, 'profile:local:user');
    assert.equal(session.participant.profileAvatar.config.generated, true);
    assert.equal(session.participant.profileAvatar.config.seed, 'profile:local:user');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'User')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.agentId, 'profile:local:user');
});

test('meeting details prefer fresher LiveKit avatar attributes over stale stored projection', async () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const authInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Live avatar attribute room',
        authInfo
    });
    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-live-avatar',
        avatar: {
            enabled: true,
            fallbackLetter: 'A',
            config: {
                agentId: 'profile:local:admin',
                generated: true,
                size: '72',
                seed: 'profile:local:admin',
                style: 'robot-soft',
                emotion: 'neutral'
            }
        },
        authInfo
    });
    const freshAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        updatedAt: '2099-05-20T10:00:00.000Z',
        config: {
            agentId: 'profile:local:admin',
            generated: true,
            size: '32',
            seed: 'profile:local:admin',
            style: 'sketch',
            emotion: 'confused',
            complexity: 'high'
        }
    };

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin', {
        webmeetUserId: 'local:admin',
        userId: 'local:admin',
        workspaceUserId: 'local:admin',
        ploinkyUserId: 'local:admin',
        webmeetProfileAvatar: JSON.stringify(freshAvatar)
    })]);

    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.size, '32');
    assert.equal(participant.profileAvatar.config.style, 'sketch');
    assert.equal(participant.profileAvatar.config.emotion, 'confused');
});

test('unauthenticated meeting join ignores avatar projection payloads', () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Unauthenticated avatar payload room',
        authInfo: adminAuthInfo
    });

    const session = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Visitor',
        participantId: 'participant-visitor',
        avatar: {
            enabled: true,
            fallbackLetter: 'V',
            config: {
                agentId: 'profile:visitor',
                generated: true,
                seed: 'profile:visitor'
            }
        }
    });

    assert.equal(session.participant.userId, undefined);
    assert.equal(session.participant.profileAvatar, undefined);
});

test('guest meeting join does not publish authenticated avatar identity or projection', () => {
    const context = createStoreContext(tempRoot);
    const workspace = createWorkspace(context);
    const adminAuthInfo = {
        user: {
            id: 'local:admin',
            username: 'admin',
            roles: ['admin']
        }
    };
    const meeting = createMeeting(context, {
        workspaceId: workspace.id,
        title: 'Guest avatar room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Person',
        participantId: 'guest-person-1'
    });

    assert.equal(session.participant.guest, true);
    assert.equal(session.participant.userId, undefined);
    assert.equal(session.participant.attributes, undefined);
    assert.equal(session.participant.profileAvatar, undefined);

    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes, undefined);
});

test('authenticated dashboard join keeps using the protected MCP tool path', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('async publishCurrentParticipantAvatar'));
    assert.match(joinMethod, /runTool\('webmeet_meeting_join', payload\)/);
    assert.doesNotMatch(joinMethod, /public-services\/webmeet/);
    assert.doesNotMatch(joinMethod, /\/meetings\/.*\/join/);
});

test('participant avatar refresh keeps using the protected MCP tool path', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(source.indexOf('async publishCurrentParticipantAvatar'), source.indexOf('async leaveMeeting'));
    assert.match(method, /runTool\('webmeet_participant_avatar_update'/);
    assert.doesNotMatch(method, /\/participants\/.*\/avatar/);
});

test('authenticated dashboard join publishes avatar after LiveKit is connected', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('async publishCurrentParticipantAvatar'));
    assert.match(joinMethod, /this\.state\.session = await runTool\('webmeet_meeting_join', payload\)/);
    assert.match(joinMethod, /await this\.connectRoom\(\);[\s\S]*await this\.publishCurrentParticipantAvatar/);
});

test('connected meeting view does not open room EventSource directly', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const realtimeSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    assert.doesNotMatch(source, /startMeetingEvents/);
    assert.doesNotMatch(source, /EventSource/);
    assert.doesNotMatch(realtimeSource, /startMeetingEvents/);
    assert.doesNotMatch(realtimeSource, /new EventSource/);
    assert.doesNotMatch(realtimeSource, /guest-sse/);
});

test('all WebMeet realtime transports normalize into the same internal event handler', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(roomSource, /emitWebMeetInternalEvent\('livekit'/);
    assert.doesNotMatch(dashboardSource, /emitWebMeetInternalEvent\('guest-sse'/);
    assert.doesNotMatch(dashboardSource, /new EventSource/);
    assert.match(dashboardSource, /emitWebMeetInternalEvent\('authenticated-workspace'/);
    assert.match(dashboardSource, /window\.dispatchEvent\(new CustomEvent\('webmeet:event'/);
    assert.match(dashboardSource, /handleWebMeetInternalEvent\(detail = \{\}\)/);
});

test('authenticated workspace view does not open protected HTTP EventSource directly', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('\n    startWorkspaceEvents()');
    const method = source.slice(startIndex, source.indexOf('\n    stopWorkspaceEvents()', startIndex));
    assert.doesNotMatch(method, /new EventSource/);
    assert.doesNotMatch(method, /services\/webmeet/);
    assert.match(method, /runTool\('webmeet_workspace_events_list'/);
    assert.match(method, /let initialized = false/);
    assert.match(method, /events\[events\.length - 1\]/);
    assert.match(method, /AUTHENTICATED_WORKSPACE_EVENT_POLL_MS/);
    assert.match(source, /scheduleWorkspaceRosterRefresh\(\)/);
});

test('authenticated beforeunload does not send protected HTTP leave keepalive', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('buildLeaveRequest:');
    const method = source.slice(startIndex, source.indexOf('\n            }\n        });', startIndex));
    assert.match(method, /if \(this\.isGuestSession\(\)\)/);
    assert.match(method, /return null;/);
    assert.doesNotMatch(method, /\/leave/);
    assert.doesNotMatch(method, /buildAuthenticatedWebMeetApiBaseUrl/);
});

test('LiveKit data channel applies participant avatar changes without snapshot resync overwrite', () => {
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    assert.match(roomSource, /emitWebMeetInternalEvent\('livekit', data/);
    assert.match(dashboardSource, /source === 'livekit' && type === 'participant\.avatar\.updated'/);
    assert.match(dashboardSource, /this\.applyRealtimeParticipantAvatar\?\.\(eventData\)/);
    const livekitAvatarBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.updated'"),
        dashboardSource.indexOf('\n            }\n            if (source ===', dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.updated'"))
    );
    assert.doesNotMatch(livekitAvatarBranch, /syncParticipantsFromRoom/);
});

test('LiveKit data channel publishes reliable payloads with current client API', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const method = dashboardSource.slice(
        dashboardSource.indexOf('async publishRealtimePayload'),
        dashboardSource.indexOf('\n    startWorkspaceEvents()', dashboardSource.indexOf('async publishRealtimePayload'))
    );

    assert.match(method, /publishData\(encoder\.encode\(JSON\.stringify\(payload\)\), \{ reliable: true \}\)/);
    assert.doesNotMatch(method, /DataPacket_Kind/);
});

test('LiveKit avatar updates are applied without reloading stale meeting details', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const livekitAvatarBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.updated'"),
        dashboardSource.indexOf('\n            }\n            if (source ===', dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.updated'"))
    );

    assert.match(livekitAvatarBranch, /this\.applyRealtimeParticipantAvatar\?\.\(eventData\)/);
    assert.doesNotMatch(livekitAvatarBranch, /loadMeetingDetails/);
});

test('LiveKit participant connection refreshes roster projection before final card sync', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js'
        ),
        'utf8'
    );
    const participantConnected = source.slice(
        source.indexOf('onParticipantConnected:'),
        source.indexOf('onParticipantDisconnected:', source.indexOf('onParticipantConnected:'))
    );
    assert.match(participantConnected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
    assert.doesNotMatch(participantConnected, /republishCurrentParticipantAvatarState/);
    assert.match(participantConnected, /await this\.loadMeetingDetails\(\)/);
    assert.match(participantConnected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);

    const connected = source.slice(
        source.indexOf('onConnected:'),
        source.indexOf('onConnectError:', source.indexOf('onConnected:'))
    );
    assert.match(connected, /await this\.loadMeetingDetails\(\)/);
    assert.match(connected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
    assert.match(connected, /await this\.publishCurrentParticipantAvatar\?\.\(\{ force: true \}\)/);
    assert.doesNotMatch(connected, /requestRoomAvatarState/);
});

test('LiveKit participant attribute changes resync room avatar state', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/livekit-room-controller.js'
        ),
        'utf8'
    );
    const roomSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js'
        ),
        'utf8'
    );

    assert.match(source, /RoomEvent\.ParticipantAttributesChanged/);
    assert.match(source, /hooks\.onParticipantAttributesChanged/);
    assert.match(roomSource, /onParticipantAttributesChanged/);
    assert.match(roomSource, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
});

test('participant avatar realtime payload includes sanitized avatar projection', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(source.indexOf('async publishCurrentParticipantAvatar'), source.indexOf('async leaveMeeting'));
    assert.match(method, /type: 'participant\.avatar\.updated'/);
    assert.match(source, /async publishCurrentParticipantAvatarState/);
    assert.match(source, /async republishCurrentParticipantAvatarState/);
    assert.doesNotMatch(source, /async requestRoomAvatarState/);
    assert.match(source, /localParticipant\.setAttributes/);
    assert.match(source, /webmeetProfileAvatar: JSON\.stringify\(avatarProjection\)/);
    assert.match(method, /userId/);
    assert.match(method, /profileAvatar/);
});

test('LiveKit avatar republish reads the current profile instead of reusing view or session state', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const stateMethod = source.slice(
        source.indexOf('async publishCurrentParticipantAvatarState'),
        source.indexOf('async republishCurrentParticipantAvatarState', source.indexOf('async publishCurrentParticipantAvatarState'))
    );
    const republishMethod = source.slice(
        source.indexOf('async republishCurrentParticipantAvatarState'),
        source.indexOf('async publishCurrentParticipantAvatar', source.indexOf('async republishCurrentParticipantAvatarState'))
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('buildParticipantAvatarProjection'));

    assert.doesNotMatch(stateMethod, /localViewAvatar/);
    assert.doesNotMatch(stateMethod, /session\?\.participant\?\.profileAvatar/);
    assert.match(stateMethod, /resolveCurrentParticipantAvatarProjection\(\{ force: true \}\)/);
    assert.match(republishMethod, /publishCurrentParticipantAvatar\(\{ force: true \}\)/);
    assert.match(joinMethod, /await this\.publishCurrentParticipantAvatar\(\{ force: true \}\)/);
    assert.doesNotMatch(joinMethod, /publishCurrentParticipantAvatar\(\{ force: true,[\s\S]*avatar: initialAvatar/);
});

test('LiveKit avatar sync requests do not make other participants read their own profile', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const requestBranch = dashboardSource.slice(
        dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.request'"),
        dashboardSource.indexOf("\n        if (['participant.joined'", dashboardSource.indexOf("source === 'livekit' && type === 'participant.avatar.request'"))
    );

    assert.match(requestBranch, /return/);
    assert.doesNotMatch(requestBranch, /republishCurrentParticipantAvatarState/);
    assert.doesNotMatch(requestBranch, /publishCurrentParticipantAvatar/);
});

test('profile avatar workspace events only refresh and republish current user room avatar projection', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const methodStart = dashboardSource.lastIndexOf('handleProfileAvatarWorkspaceEvent(event)');
    const method = dashboardSource.slice(
        methodStart,
        dashboardSource.indexOf('\n};', methodStart)
    );

    assert.match(method, /userId === currentUserId/);
    assert.match(method, /this\.participantLayoutController\?\.refreshAvatarForUser\?\.\(userId\)/);
    assert.match(method, /this\.publishCurrentParticipantAvatar\(\{ force: true \}\)/);
    assert.ok(
        method.indexOf('this.participantLayoutController?.refreshAvatarForUser?.(userId)') > method.indexOf('userId === currentUserId'),
        'remote workspace profile events must not refresh remote participant avatars'
    );
});

test('avatar settings updates republish the joined participant avatar even without a user id in the event', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async handleAvatarSettingsUpdated');
    const method = source.slice(startIndex, source.indexOf('\n    handleProfileAvatarWorkspaceEvent', startIndex));
    assert.doesNotMatch(method, /selectedWorkspaceId/);
    assert.doesNotMatch(method, /if \(!userId\) return/);
    assert.match(method, /this\.state\.session\?\.participantIdentity/);
    assert.match(method, /normalizeAvatarConfig/);
    assert.match(method, /applyRealtimeParticipantAvatar/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
    assert.match(method, /publishCurrentParticipantAvatarState/);
    assert.match(method, /publishCurrentParticipantAvatar/);
    assert.match(method, /skipRealtime: true/);
});

test('avatar settings updates from another logged-in user update the matching remote participant without publishing local state', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-realtime-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async handleAvatarSettingsUpdated');
    const method = source.slice(startIndex, source.indexOf('\n    handleProfileAvatarWorkspaceEvent', startIndex));
    assert.match(method, /eventUserId/);
    assert.match(method, /currentUserId/);
    const remoteBranch = method.slice(
        method.indexOf('eventUserId !== currentUserId'),
        method.indexOf('if (!this.state.session?.participantIdentity)', method.indexOf('eventUserId !== currentUserId'))
    );
    assert.match(remoteBranch, /applyRealtimeParticipantAvatar/);
    assert.match(remoteBranch, /userId: eventUserId/);
    assert.doesNotMatch(remoteBranch, /syncParticipantsFromRoom/);
    assert.doesNotMatch(remoteBranch, /publishCurrentParticipantAvatar/);
});

test('workspace roster events reload meeting list before fetching meeting details', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async refreshWorkspaceRosterFromEvent');
    const method = source.slice(startIndex, source.indexOf('\n    async refreshMeetingDetailsFromRealtimeEvent', startIndex));
    assert.match(method, /await this\.loadMeetings\(\)/);
    assert.doesNotMatch(method, /await this\.loadParticipantsForMeetings\(\)/);
});

test('missing meeting ids are removed from local roster state', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async loadParticipantsForMeetings');
    const method = source.slice(startIndex, source.indexOf('\n    async loadMeetingDetails', startIndex));
    assert.match(method, /missingMeetingIds/);
    assert.match(method, /isMissingMeetingError\(result\.reason\)/);
    assert.match(method, /this\.state\.meetings = meetings\.filter/);
});
