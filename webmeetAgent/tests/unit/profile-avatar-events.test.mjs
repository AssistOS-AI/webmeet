import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    decryptPayload,
    deriveMasterKey,
    encryptPayload,
    unwrapDek
} from '../../lib/webmeetCrypto.mjs';
import {
    createMeeting,
    createStoreContext,
    createWorkspace,
    getGuestMeetingDetails,
    getMeeting,
    joinGuestMeeting,
    joinMeeting,
    listWorkspaceEvents,
    recordProfileAvatarUpdated,
    updateGuestMeetingParticipantAvatar,
    updateMeetingParticipantAvatar
} from '../../lib/webmeetStore.mjs';
import { dashboardSessionMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-session-methods.js';

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

function rewriteMeetingPayloadMembers(context, meetingId, transform) {
    const filePath = path.join(context.meetingsDir, `${meetingId}.json`);
    const record = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const masterKey = deriveMasterKey(process.env.PLOINKY_WEBMEET_MASTER_KEY);
    const dek = unwrapDek(masterKey, record.dek);
    const payload = decryptPayload(dek, record.payload);
    payload.members = transform(Array.isArray(payload.members) ? payload.members : []);
    record.payload = encryptPayload(dek, payload);
    fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`);
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

test('participant avatar update returns a sanitized live projection without persisting roster avatar', async () => {
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
    assert.equal(participant.profileAvatar, null);

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

test('join does not persist avatar projection or token avatar attributes', async () => {
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

    assert.equal(session.participant.profileAvatar, undefined);
    const [, payloadSegment] = session.participantToken.split('.');
    const jwtPayload = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
    assert.equal(jwtPayload.attributes.webmeetProfileAvatar, undefined);

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Admin')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar, null);
});

test('join ignores avatar payloads until a live avatar projection is published', async () => {
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

    assert.equal(session.participant.profileAvatar, undefined);

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'User')]);
    const details = await getMeeting(context, meeting.id, authInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.profileAvatar, null);
});

test('meeting details read avatar projection from LiveKit participant attributes', async () => {
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
        authInfo
    });
    const liveAvatar = {
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
        webmeetProfileAvatar: JSON.stringify(liveAvatar)
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

test('guest participant avatar override is returned for live propagation without meeting-store persistence', async () => {
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
        title: 'Guest avatar override room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Person',
        participantId: 'guest-person-override'
    });

    const updated = updateGuestMeetingParticipantAvatar(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: session.participantIdentity,
        avatar: {
            enabled: true,
            fallbackLetter: 'G',
            config: {
                generated: true,
                emotion: 'happy',
                seed: 'guest-person-override'
            }
        }
    });

    assert.equal(updated.profileAvatar.enabled, true);
    assert.equal(updated.profileAvatar.config.emotion, 'happy');

    setLiveKitParticipants(context, [liveKitParticipant(session.participantIdentity, 'Guest Person')]);
    const details = await getMeeting(context, meeting.id, adminAuthInfo);
    const participant = details.participants.find((entry) => entry.id === session.participantIdentity);
    assert.equal(participant.guest, true);
    assert.equal(participant.userId, undefined);
    assert.equal(participant.attributes?.webmeetUserId, undefined);
    assert.equal(participant.attributes?.workspaceUserId, undefined);
    assert.equal(participant.attributes?.ploinkyUserId, undefined);
    assert.equal(participant.profileAvatar, null);
});

test('guest meeting details allow a joined guest before LiveKit presence appears', async () => {
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
        title: 'Guest bootstrap room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Bootstrap',
        participantId: 'guest-bootstrap-1'
    });

    const details = await getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: session.participantIdentity
    });

    assert.equal(details.meeting.id, meeting.id);
    assert.ok(Array.isArray(details.participants));
    assert.equal(details.participants[0]?.id, session.participantIdentity);
});

test('guest meeting details tolerate stored guest members that lost the guest flag', async () => {
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
        title: 'Guest degraded membership room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Degraded',
        participantId: 'guest-degraded-1'
    });

    rewriteMeetingPayloadMembers(context, meeting.id, (members) => members.map((member) => {
        if (String(member?.id || '').trim() !== session.participantIdentity) {
            return member;
        }
        return {
            id: member.id,
            displayName: member.displayName,
            joinedAt: member.joinedAt,
            lastSeenAt: member.lastSeenAt,
            attributes: member.attributes || {}
        };
    }));

    const details = await getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: session.participantIdentity
    });

    assert.equal(details.meeting.id, meeting.id);
    assert.equal(details.participants[0]?.id, session.participantIdentity);
});

test('guest meeting details do not wipe stored members when LiveKit roster is temporarily empty', async () => {
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
        title: 'Guest empty roster room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const session = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Empty',
        participantId: 'guest-empty-1'
    });

    setLiveKitParticipants(context, []);

    const details = await getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: session.participantIdentity
    });

    assert.equal(details.participants[0]?.id, session.participantIdentity);

    const repeatDetails = await getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: session.participantIdentity
    });

    assert.equal(repeatDetails.participants[0]?.id, session.participantIdentity);
});

test('authenticated dashboard join keeps using the protected MCP tool path', () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-api.js'
        ),
        'utf8'
    );
    const joinMethod = actionSource.slice(actionSource.indexOf('async joinMeeting'), actionSource.indexOf('buildParticipantAvatarProjection'));
    assert.match(joinMethod, /this\.roomRuntime\.joinAuthenticated\(payload\)/);
    assert.match(apiSource, /runTool\('webmeet_meeting_join', payload\)/);
    assert.doesNotMatch(joinMethod, /public-services\/webmeet/);
    assert.doesNotMatch(joinMethod, /\/meetings\/.*\/join/);
});

test('participant avatar refresh keeps using the protected MCP tool path', () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-api.js'
        ),
        'utf8'
    );
    const method = actionSource.slice(actionSource.indexOf('async publishCurrentParticipantAvatar'), actionSource.indexOf('async leaveMeeting'));
    assert.match(method, /this\.roomRuntime\.publishAvatar\(avatar\)/);
    assert.match(apiSource, /runTool\('webmeet_participant_avatar_update'/);
    assert.doesNotMatch(method, /\/participants\/.*\/avatar/);
});

test('guest participant avatar refresh uses the scoped guest public API path', () => {
    const actionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-api.js'
        ),
        'utf8'
    );
    const method = actionSource.slice(actionSource.indexOf('async publishCurrentParticipantAvatar'), actionSource.indexOf('async leaveMeeting'));
    assert.match(method, /this\.roomRuntime\.publishAvatar\(avatar\)/);
    assert.match(apiSource, /callPublicGuestApi\(meetingId,\s*'guest-avatar',\s*\{\s*avatar\s*\}\)/);
    assert.doesNotMatch(method, /if \(this\.isGuestSession\(\)\) return/);
});

test('authenticated dashboard join connects before publishing avatar best-effort', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('buildParticipantAvatarProjection'));
    assert.match(joinMethod, /this\.state\.session = await this\.roomRuntime\.joinAuthenticated\(payload\)/);
    assert.match(joinMethod, /await this\.roomRuntime\.connect\(\)/);
    assert.match(joinMethod, /void this\.publishCurrentParticipantAvatar\(\{ force: true \}\)\.catch/);
    assert.ok(
        joinMethod.indexOf('await this.roomRuntime.connect()') < joinMethod.indexOf('void this.publishCurrentParticipantAvatar({ force: true }).catch'),
        'avatar publish must happen after room connect'
    );
    assert.doesNotMatch(joinMethod, /await this\.publishCurrentParticipantAvatar\(\{ force: true/);
    assert.doesNotMatch(joinMethod, /initialAvatarState/);
    assert.doesNotMatch(joinMethod, /payload\.avatar/);
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

test('LiveKit participant connection republishes local avatar state for late joiners without meeting refresh', () => {
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
    assert.match(participantConnected, /this\.republishCurrentParticipantAvatarState\?\.\(\)\.catch/);
    assert.match(participantConnected, /this\.requestRoomAvatarState\?\.\(\)\.catch/);
    assert.doesNotMatch(participantConnected, /loadMeetingDetails/);

    const connected = source.slice(
        source.indexOf('onConnected:'),
        source.indexOf('onConnectError:', source.indexOf('onConnected:'))
    );
    assert.match(connected, /await this\.loadMeetingDetails\(\{ includeParticipants: false \}\)/);
    assert.match(connected, /this\.syncParticipantsFromRoom\(this\.room, Track\)/);
    assert.match(connected, /await this\.republishCurrentParticipantAvatarState\?\.\(\)/);
    assert.match(connected, /await this\.requestRoomAvatarState\?\.\(\)/);
    assert.doesNotMatch(connected, /publishCurrentParticipantAvatar\?\.\(\{ force: true \}\)/);
});

test('LiveKit participant attribute changes apply avatar projection before room resync', () => {
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
    assert.match(roomSource, /applyRealtimeParticipantAvatar\?\.\(\{/);
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
    assert.match(source, /getCurrentPublishedParticipantAvatarState/);
    assert.match(source, /localParticipant\.setAttributes/);
    assert.match(source, /webmeetProfileAvatar: JSON\.stringify\(avatarProjection\)/);
    assert.match(method, /userId/);
    assert.match(method, /profileAvatar/);
    assert.match(method, /const profileAvatar = avatar && typeof avatar === 'object'/);
});

test('LiveKit avatar republish reuses the current live projection before recomputing profile state', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const stateMethod = source.slice(
        source.indexOf('async publishCurrentParticipantAvatarState'),
        source.indexOf('getCurrentPublishedParticipantAvatarState()', source.indexOf('async publishCurrentParticipantAvatarState'))
    );
    const currentStateMethod = source.slice(
        source.indexOf('getCurrentPublishedParticipantAvatarState()'),
        source.indexOf('async republishCurrentParticipantAvatarState', source.indexOf('async publishCurrentParticipantAvatarState'))
    );
    const republishMethod = source.slice(
        source.indexOf('async republishCurrentParticipantAvatarState'),
        source.indexOf('async publishCurrentParticipantAvatar', source.indexOf('async republishCurrentParticipantAvatarState'))
    );
    const joinMethod = source.slice(source.indexOf('async joinMeeting'), source.indexOf('buildParticipantAvatarProjection'));

    assert.doesNotMatch(stateMethod, /localViewAvatar/);
    assert.match(stateMethod, /resolveCurrentParticipantAvatarProjection\(\{ force: true \}\)/);
    assert.match(currentStateMethod, /localParticipant\.attributes/);
    assert.match(currentStateMethod, /session\?\.participant\?\.profileAvatar/);
    assert.match(republishMethod, /getCurrentPublishedParticipantAvatarState/);
    assert.match(republishMethod, /publishCurrentParticipantAvatarState\(/);
    assert.doesNotMatch(republishMethod, /webmeet_participant_avatar_update/);
    assert.match(joinMethod, /void this\.publishCurrentParticipantAvatar\(\{ force: true \}\)\.catch/);
    assert.doesNotMatch(joinMethod, /initialAvatarState/);
    assert.doesNotMatch(joinMethod, /publishCurrentParticipantAvatar\(\{ force: true,[\s\S]*avatar: initialAvatar/);
});

test('participant avatar publish does not resync the room snapshot', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async publishCurrentParticipantAvatar'),
        source.indexOf('\n    async leaveMeeting', source.indexOf('async publishCurrentParticipantAvatar'))
    );

    assert.match(method, /await this\.publishCurrentParticipantAvatarState\(profileAvatar, sourceAvatar\)/);
    assert.match(method, /this\.applyRealtimeParticipantAvatar\?\.\(/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
});

test('LiveKit avatar sync requests trigger live republish without backend writes', () => {
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

    assert.match(requestBranch, /requesterParticipantId/);
    assert.match(requestBranch, /localParticipantId/);
    assert.match(requestBranch, /republishCurrentParticipantAvatarState\?\.\(\)\.catch/);
    assert.doesNotMatch(requestBranch, /publishCurrentParticipantAvatar\(/);
    assert.doesNotMatch(requestBranch, /webmeet_participant_avatar_update/);
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
    assert.match(method, /loadCurrentWebMeetAvatarOverride/);
    assert.match(method, /if \(!currentOverride\)/);
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
    assert.match(method, /loadCurrentWebMeetAvatarOverride/);
    assert.match(method, /this\.state\.webMeetAvatarOverride = currentOverride/);
    assert.match(method, /applyRealtimeParticipantAvatar/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
    assert.match(method, /publishCurrentParticipantAvatarState/);
    assert.match(method, /publishCurrentParticipantAvatar/);
    assert.match(method, /avatar: effectiveSourceAvatar/);
    assert.match(method, /skipRealtime: true/);
    assert.doesNotMatch(method, /config: event\.detail\.config/);
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

test('WebMeet avatar override is browser scoped and participates in effective avatar projection', () => {
    const serviceSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-avatar-override.js'
        ),
        'utf8'
    );
    const meetingActionSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js'
        ),
        'utf8'
    );

    assert.match(serviceSource, /STORAGE_PREFIX = 'webmeet\.avatarOverride\.'/);
    assert.match(serviceSource, /window\?\.localStorage\?\.setItem/);
    assert.match(serviceSource, /window\?\.localStorage\?\.removeItem/);
    assert.match(serviceSource, /buildWebMeetAvatarSource/);
    assert.match(serviceSource, /config: normalizeAvatarConfig\(config/);
    assert.match(serviceSource, /buildWebMeetAvatarOverrideConfig/);
    assert.match(serviceSource, /\.\.\.baseConfig,[\s\S]*\.\.\.patch/);
    assert.match(meetingActionSource, /resolveCurrentWebMeetAvatarSource/);
    assert.match(meetingActionSource, /buildWebMeetAvatarSource/);
    assert.match(meetingActionSource, /const override = this\.loadCurrentWebMeetAvatarOverride\(\)/);
    assert.match(meetingActionSource, /if \(this\.isGuestSession\(\)\) \{\s*return '';\s*\}/);
    assert.doesNotMatch(meetingActionSource, /this\.state\.webMeetAvatarOverride \|\| this\.loadCurrentWebMeetAvatarOverride\(\)/);
    assert.match(meetingActionSource, /await this\.resolveCurrentWebMeetAvatarSource\(\{[\s\S]*participantId[\s\S]*\}\)/);
    assert.match(meetingActionSource, /void this\.publishCurrentParticipantAvatar\(\{ force: true \}\)\.catch/);
    assert.doesNotMatch(meetingActionSource, /initialAvatarState/);
    assert.match(meetingActionSource, /WebMeet avatar override applied and published\./);
    assert.match(meetingActionSource, /WebMeet avatar override saved\. Join a room to publish it\./);
    assert.match(meetingActionSource, /this\.renderParticipantLayout\?\.\(\)/);
    assert.match(meetingActionSource, /this\.renderMeetingList\?\.\(\)/);
});

test('WebMeet avatar UI exposes settings and quick preset controls', () => {
    const html = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html'
        ),
        'utf8'
    );
    const renderSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js'
        ),
        'utf8'
    );
    const css = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.css'
        ),
        'utf8'
    );

    assert.match(html, /id="webmeetAvatarPresetSelect"/);
    assert.doesNotMatch(html, /id="webmeetAvatarOverrideEnabled"/);
    assert.match(html, /id="webmeetSettingsTabMedia"/);
    assert.match(html, /id="webmeetSettingsTabAvatar"/);
    assert.match(html, /data-local-action="setSettingsTab"/);
    assert.match(html, /id="webmeetAudioVideoSettingsTabPanel"/);
    assert.match(html, /id="webmeetAvatarSettingsTabPanel"/);
    assert.match(html, /data-settings-tab-panel="avatar" hidden/);
    assert.match(css, /\.webmeet-settings-section\[hidden\][\s\S]*display: none !important/);
    assert.match(css, /\.webmeet-settings-tabs[\s\S]*border-bottom: 1px solid var\(--border\)/);
    assert.match(html, /id="webmeetAvatarStyle"/);
    assert.match(html, /id="webmeetAvatarSrc"/);
    assert.match(html, /id="webmeetAvatarPackSrc"/);
    assert.match(html, /id="webmeetAvatarPreview"/);
    assert.match(html, /Reset to profile/);
    assert.match(html, /data-local-action="applyWebMeetAvatarSettings"/);
    assert.match(html, /data-local-action="resetWebMeetAvatarOverride"/);
    assert.match(html, /id="webmeetAvatarQuickButton"/);
    assert.match(html, /id="webmeetAvatarQuickMenu"/);
    assert.match(renderSource, /WEBMEET_AVATAR_PRESETS/);
    assert.match(renderSource, /ensureAxiFaceLoaded/);
    assert.match(renderSource, /avatarPreviewLoadPromise/);
    assert.match(renderSource, /data-local-action="applyWebMeetAvatarPreset"/);
    assert.match(renderSource, /data-avatar-preset/);
});

test('dashboard guest session detection is safe before guest manager init', () => {
    assert.equal(
        dashboardSessionMethods.isGuestSession.call({
            state: {}
        }),
        false
    );
    assert.equal(
        dashboardSessionMethods.isGuestSession.call({
            state: {
                session: {
                    guest: true
                }
            }
        }),
        true
    );
    assert.equal(
        dashboardSessionMethods.isGuestSession.call({
            state: {
                session: {
                    publicApiBaseUrl: '/public-services/webmeet'
                }
            }
        }),
        true
    );
});

test('guest bootstrap republishes the current avatar override after connecting', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-session-methods.js'
        ),
        'utf8'
    );

    assert.match(
        source,
        /async bootstrapGuestSession\(session\) \{\s*await this\.guestManager\.bootstrapGuestSession\(session\);\s*void this\.publishCurrentParticipantAvatar\(\{ force: true \}\)\.catch/
    );
});

test('guest WebMeet avatar runtime avoids protected Explorer imports and uses public AxiFace assets', () => {
    const participantCardSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js'
        ),
        'utf8'
    );
    const runtimeSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-profile-avatar-runtime.js'
        ),
        'utf8'
    );
    const proxySource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../server/webmeet-public-proxy.mjs'
        ),
        'utf8'
    );

    assert.doesNotMatch(participantCardSource, /\/explorer\/services\/profile-avatar-client\.js/);
    assert.match(participantCardSource, /webmeet-profile-avatar-runtime\.js/);
    assert.match(runtimeSource, /isGuestWebMeetContext/);
    assert.match(runtimeSource, /\/public-services\/webmeet\/axi-face\/src\/axi-face\.mjs/);
    assert.match(proxySource, /routedPathname\.startsWith\('\/api\/axi-face\/'\)/);
    assert.match(proxySource, /handlePublicAxiFaceAssetRequest/);
    assert.match(proxySource, /workspaceRoot:\s*WORKSPACE_ROOT/);
    assert.match(proxySource, /assets\/explorer\/WebSkel\/webskel\.mjs/);
});

test('participant audio settings use the registered modal API and do not use browser prompts', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/media-settings-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async openParticipantAudioSettings'),
        source.indexOf('\n    }\n};', source.indexOf('async openParticipantAudioSettings'))
    );

    assert.match(method, /globalThis\.assistOS\?\.UI/);
    assert.match(method, /typeof globalThis\.assistOS\.UI\.showModal === 'function'/);
    assert.doesNotMatch(method, /prompt/);
    assert.doesNotMatch(method, /confirm/);
    assert.doesNotMatch(method, /await assistOS\.UI\.showModal/);
});

test('authenticated meeting refresh keeps a just-joined guest until LiveKit exposes the participant', async () => {
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
        title: 'Guest pending LiveKit room',
        roomType: 'guest',
        authInfo: adminAuthInfo
    });

    const adminSession = joinMeeting(context, {
        meetingId: meeting.id,
        displayName: 'Admin',
        participantId: 'participant-admin-1',
        authInfo: adminAuthInfo
    });
    const guestSession = joinGuestMeeting(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        displayName: 'Guest Pending',
        participantId: 'guest-pending-1'
    });

    setLiveKitParticipants(context, [liveKitParticipant(adminSession.participantIdentity, 'Admin')]);

    const adminDetails = await getMeeting(context, meeting.id, adminAuthInfo);
    assert.deepEqual(adminDetails.participants.map((entry) => entry.id).sort(), [
        guestSession.participantIdentity,
        adminSession.participantIdentity
    ].sort());

    const guestDetails = await getGuestMeetingDetails(context, {
        meetingId: meeting.id,
        guestToken: meeting.guestToken,
        participantId: guestSession.participantIdentity
    });

    assert.equal(guestDetails.participants.some((entry) => entry.id === guestSession.participantIdentity), true);
});

test('public WebMeet proxy normalizes guest-facing routes under /public-services/webmeet', () => {
    const proxySource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../server/webmeet-public-proxy.mjs'
        ),
        'utf8'
    );

    assert.match(proxySource, /function normalizePublicServicePathname/);
    assert.match(proxySource, /normalized\.startsWith\(PUBLIC_SERVICE_PREFIX\)/);
    assert.match(proxySource, /if \(normalized === '\/guest'\) return '\/api\/guest'/);
    assert.match(proxySource, /if \(normalized\.startsWith\('\/assets\/'\)\) return `\/api\/\$\{normalized\.slice\(1\)\}`/);
    assert.match(proxySource, /if \(normalized\.startsWith\('\/meetings\/'\)\) return `\/api\/\$\{normalized\.slice\(1\)\}`/);
    assert.match(proxySource, /const routedPathname = normalizePublicServicePathname\(pathname\)/);
    assert.match(proxySource, /if \(isAllowedPublicApi\(req, routedPathname\)\)/);
    assert.match(proxySource, /proxy\(req, res, API_PORT, `\$\{routedPathname\}\$\{url\.search \|\| ''\}`\)/);
    assert.match(proxySource, /relativePath\.startsWith\('explorer\/WebSkel\/'\)/);
});

test('guest HTTP API returns the underlying guest error message', () => {
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../server/webmeet-api.mjs'
        ),
        'utf8'
    );

    assert.match(apiSource, /json\(res, 403, \{ error: error instanceof Error \? error\.message : String\(error\) \}\)/);
});

test('guest session manager preserves guest auth context for public guest APIs', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/service-components/guest-session-manager.js'
        ),
        'utf8'
    );

    assert.match(source, /readGuestInviteTokenFromUrl/);
    assert.match(source, /session\?\.guestToken/);
    assert.match(source, /session\?\.meeting\?\.guestToken/);
    assert.match(source, /session\?\.participantIdentity/);
    assert.match(source, /session\?\.participant\?\.id/);
    const dataSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const apiSource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room-runtime/webmeet-room-api.js'
        ),
        'utf8'
    );
    assert.match(dataSource, /return this\.roomRuntime\.loadGuestRoomState\(meetingId\)/);
    assert.match(apiSource, /return this\.callPublicGuestApi\(meetingId, 'guest-state', \{\}\)/);
});

test('guest page bootstraps WebMeet dashboard through WebSkel components', () => {
    const proxySource = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../server/webmeet-public-proxy.mjs'
        ),
        'utf8'
    );

    assert.match(proxySource, /import\('\.\/assets\/explorer\/WebSkel\/webskel\.mjs'\)/);
    assert.match(proxySource, /webSkelClass\.initialise\('\.\/assets\/vendor\/webmeet-guest-webskel\.json'\)/);
    assert.match(proxySource, /registerWebSkelComponentConfig\(\{\s*name: 'webmeet-participant-audio-modal',\s*type: 'modal',\s*presenterClassName: 'WebmeetParticipantAudioModal'\s*\}\)/s);
    assert.match(proxySource, /await webSkel\.defineComponent\(\{\s*name: 'webmeet-participant-card'/s);
    assert.match(proxySource, /await webSkel\.defineComponent\(\{\s*name: 'webmeet-dashboard-modal'/s);
    assert.match(proxySource, /await webSkel\.defineComponent\(\{\s*name: 'webmeet-participant-audio-modal'/s);
    assert.match(proxySource, /webmeet-participant-audio-modal\.html/);
    assert.match(proxySource, /webmeet-participant-audio-modal\.css/);
    assert.match(proxySource, /webmeet-participant-audio-modal\.js/);
    assert.match(proxySource, /window\.assistOS\.UI\.showModal = webSkelModule\.showModal/);
    assert.match(proxySource, /window\.assistOS\.UI\.closeModal = webSkelModule\.closeModal/);
    assert.match(proxySource, /webSkel\.createElement\('webmeet-dashboard-modal', dashboardRoot,/);
    assert.match(proxySource, /'data-host-surface': 'standalone-page'/);
    assert.match(proxySource, /const guestDisplayNameStorageKey = 'webmeet\.guestDisplayName'/);
    assert.match(proxySource, /window\.localStorage\.getItem\(guestDisplayNameStorageKey\)/);
    assert.match(proxySource, /window\.localStorage\.setItem\(guestDisplayNameStorageKey,\s*String\(displayName \|\| ''\)\.trim\(\)\)/);
    assert.match(proxySource, /input\.value = readStoredGuestDisplayName\(\)/);
    assert.match(proxySource, /<link rel="stylesheet" href="\.\/assets\/explorer\/styles\.css">/);
    assert.match(proxySource, /<link rel="stylesheet" href="\.\/assets\/explorer\/plugins\.css">/);
    assert.doesNotMatch(proxySource, /createObjectURL\(configBlob\)/);
    assert.doesNotMatch(proxySource, /new module\.WebMeetDashboardModal/);
    assert.doesNotMatch(proxySource, /\.webmeet-public-dashboard \.webmeet-modal-window-actions,[\s\S]*display: none !important/);
    assert.doesNotMatch(proxySource, /\.webmeet-public-dashboard \.webmeet-dashboard-modal[\s\S]*width: 100vw/);
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

test('meeting detail refresh skips participant snapshots while the room is connected', () => {
    const source = fs.readFileSync(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-data-methods.js'
        ),
        'utf8'
    );
    const method = source.slice(
        source.indexOf('async refreshMeetingDetailsFromRealtimeEvent()'),
        source.indexOf('\n    runBestEffortRealtimeRefresh', source.indexOf('async refreshMeetingDetailsFromRealtimeEvent()'))
    );
    assert.match(method, /includeParticipants: !this\.room/);
    assert.doesNotMatch(method, /syncParticipantsFromRoom/);
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
