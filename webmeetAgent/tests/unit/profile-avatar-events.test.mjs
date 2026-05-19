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

test('participant avatar projection is stored on the meeting roster', () => {
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

    const details = getMeeting(context, meeting.id, authInfo);
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

test('join can persist avatar projection for a freshly created participant id', () => {
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

    const details = getMeeting(context, meeting.id, authInfo);
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

test('join fills a generated avatar config when authenticated profile payload has no config', () => {
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

    const details = getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar.config.agentId, 'profile:local:user');
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

test('authenticated meeting view does not open protected HTTP EventSource directly', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('startMeetingEvents()');
    const startMeetingEvents = source.slice(startIndex, source.indexOf('\n    stopMeetingEvents()', startIndex));
    assert.match(startMeetingEvents, /if \(!this\.isGuestSession\(\)\) return;/);
    assert.doesNotMatch(startMeetingEvents, /runTool\('webmeet_meeting_events_list'/);
    assert.doesNotMatch(startMeetingEvents, /startAuthenticatedMeetingEvents/);
    assert.doesNotMatch(startMeetingEvents, /services\/webmeet/);
});

test('all WebMeet realtime transports normalize into the same internal event handler', () => {
    const dashboardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
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
    assert.match(dashboardSource, /emitWebMeetInternalEvent\('guest-sse'/);
    assert.match(dashboardSource, /emitWebMeetInternalEvent\('authenticated-workspace'/);
    assert.match(dashboardSource, /window\.dispatchEvent\(new CustomEvent\('webmeet:event'/);
    assert.match(dashboardSource, /handleWebMeetInternalEvent\(detail = \{\}\)/);
});

test('authenticated workspace view does not open protected HTTP EventSource directly', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
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

test('LiveKit data channel refreshes roster when a participant avatar changes', () => {
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
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
        ),
        'utf8'
    );
    assert.match(roomSource, /emitWebMeetInternalEvent\('livekit', data/);
    assert.match(dashboardSource, /source === 'livekit' && type === 'participant\.avatar\.updated'/);
    assert.match(dashboardSource, /this\.applyRealtimeParticipantAvatar\?\.\(eventData\)/);
    assert.match(dashboardSource, /await this\.loadMeetingDetails\(\)/);
    assert.match(dashboardSource, /this\.syncParticipantsFromRoom\(this\.room, window\.LivekitClient\.Track\)/);
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
    assert.match(participantConnected, /await this\.loadMeetingDetails\(\)/);
    assert.match(participantConnected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);

    const connected = source.slice(
        source.indexOf('onConnected:'),
        source.indexOf('onConnectError:', source.indexOf('onConnected:'))
    );
    assert.match(connected, /await this\.loadMeetingDetails\(\)/);
    assert.match(connected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
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
    assert.match(method, /userId/);
    assert.match(method, /profileAvatar/);
});

test('avatar settings updates republish the joined participant avatar even without a user id in the event', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async handleAvatarSettingsUpdated');
    const method = source.slice(startIndex, source.indexOf('\n    handleProfileAvatarWorkspaceEvent', startIndex));
    assert.doesNotMatch(method, /if \(!userId\) return/);
    assert.match(method, /this\.state\.session\?\.participantIdentity/);
    assert.match(method, /publishCurrentParticipantAvatar/);
});

test('workspace roster events reload meeting list before fetching meeting details', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
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
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js'
        ),
        'utf8'
    );
    const startIndex = source.indexOf('async loadParticipantsForMeetings');
    const method = source.slice(startIndex, source.indexOf('\n    async loadMeetingDetails', startIndex));
    assert.match(method, /missingMeetingIds/);
    assert.match(method, /isMissingMeetingError\(result\.reason\)/);
    assert.match(method, /this\.state\.meetings = meetings\.filter/);
});
