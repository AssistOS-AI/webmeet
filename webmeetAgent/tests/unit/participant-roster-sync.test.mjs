import { test } from 'node:test';
import assert from 'node:assert/strict';

import { participantViewMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/participant-view-methods.js';

test('syncParticipantsFromRoom does not reuse stored remote avatars for connected-room cards', () => {
    const appliedViews = new Map();
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote',
                    workspaceUserId: 'local:remote'
                },
                profileAvatar: {
                    enabled: true,
                    fallbackLetter: 'R',
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        generated: true
                    }
                }
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            const view = {
                id,
                micOn: false
            };
            appliedViews.set(id, {
                avatarUserId: participant.userId || '',
                profileAvatar: participant.profileAvatar || null
            });
            return view;
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].id, 'participant-remote');
    assert.equal(context.state.participants[1].userId, 'local:remote');
    assert.equal(context.state.participants[1].profileAvatar, null);

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].id, 'participant-remote');
    assert.equal(context.state.participants[1].userId, 'local:remote');
    assert.equal(context.state.participants[1].profileAvatar, null);
});

test('syncParticipantsFromRoom keeps remote avatar empty after leave and rejoin until LiveKit sends it', () => {
    const appliedViews = new Map();
    const remoteAvatar = {
        enabled: true,
        fallbackLetter: 'R',
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote-old',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: remoteAvatar
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            const view = {
                id,
                micOn: false
            };
            appliedViews.set(id, {
                avatarUserId: participant.userId || '',
                profileAvatar: participant.profileAvatar || null
            });
            return view;
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView(participantId) {
            appliedViews.delete(participantId);
        },
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };
    const emptyRoom = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map()
    };
    const rejoinedRoom = {
        localParticipant: emptyRoom.localParticipant,
        remoteParticipants: new Map([
            ['participant-remote-new', {
                identity: 'participant-remote-new',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                trackPublications: new Map()
            }]
        ])
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, emptyRoom, Track);

    assert.equal(context.state.participants.length, 1);

    participantViewMethods.syncParticipantsFromRoom.call(context, rejoinedRoom, Track);

    assert.equal(context.state.participants[1].id, 'participant-remote-new');
    assert.equal(context.state.participants[1].userId, 'local:remote');
    assert.equal(context.state.participants[1].profileAvatar, null);
    assert.equal(appliedViews.get('participant-remote-new')?.profileAvatar, null);
});

test('applyRealtimeParticipantAvatar updates remote avatar size by participant or user id', () => {
    const appliedViews = [];
    const context = {
        state: {
            participants: [{
                id: 'participant-remote',
                identity: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: {
                    enabled: true,
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        generated: true,
                        size: '48'
                    }
                }
            }],
        },
        participantLayoutController: {
            getViews() {
                return [{
                    id: 'participant-remote',
                    avatarUserId: 'local:remote',
                    avatarEnabled: true,
                    avatarResolved: true,
                    avatarConfig: {
                        size: '48'
                    }
                }];
            }
        },
        applyParticipantViewState(view) {
            appliedViews.push({ ...view });
        }
    };
    const nextAvatar = {
        enabled: true,
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true,
            size: '96'
        }
    };

    const changed = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        userId: 'local:remote',
        profileAvatar: nextAvatar
    });

    assert.equal(changed, true);
    assert.equal(context.state.participants[0].profileAvatar.config.size, '96');
    assert.equal(appliedViews[0].avatarConfig.size, '96');
});

test('applyRealtimeParticipantAvatar applies the latest LiveKit payload directly', () => {
    const appliedViews = [];
    const context = {
        state: {
            participants: [{
                id: 'participant-remote',
                identity: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: {
                    enabled: true,
                    updatedAt: '2026-05-20T09:00:05.000Z',
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        generated: true,
                        size: '96'
                    }
                }
            }],
        },
        participantLayoutController: {
            getViews() {
                return [{
                    id: 'participant-remote',
                    avatarUserId: 'local:remote',
                    avatarEnabled: true,
                    avatarResolved: true,
                    avatarConfig: {
                        size: '96'
                    }
                }];
            }
        },
        applyParticipantViewState(view) {
            appliedViews.push({ ...view });
        }
    };

    const changed = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        userId: 'local:remote',
        profileAvatar: {
            enabled: true,
            updatedAt: '2026-05-20T09:00:00.000Z',
            config: {
                agentId: 'profile:local:remote',
                seed: 'profile:local:remote',
                generated: true,
                size: '48'
            }
        }
    });

    assert.equal(changed, true);
    assert.equal(context.state.participants[0].profileAvatar.config.size, '48');
    assert.equal(appliedViews[0].avatarConfig.size, '48');
});

test('syncParticipantsFromRoom ignores stored remote avatars without LiveKit state', () => {
    const appliedViews = new Map();
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: {
                    enabled: true,
                    updatedAt: '2026-05-19T10:00:00.000Z',
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        size: '48'
                    }
                }
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].profileAvatar, null);
    assert.equal(appliedViews.get('participant-remote').profileAvatar, null);
});

test('syncParticipantsFromRoom ignores stale stored LiveKit avatar attributes', () => {
    const appliedViews = new Map();
    const staleAvatar = {
        enabled: true,
        fallbackLetter: 'R',
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true,
            size: '96'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote',
                    webmeetProfileAvatar: JSON.stringify(staleAvatar)
                }
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].profileAvatar, null);
    assert.equal(appliedViews.get('participant-remote').profileAvatar, null);
});

test('syncParticipantsFromRoom reads fresh avatar projection from LiveKit participant attributes', () => {
    const appliedViews = new Map();
    const liveAvatar = {
        enabled: true,
        updatedAt: '2026-05-20T10:00:00.000Z',
        fallbackLetter: 'R',
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true,
            size: '32',
            emotion: 'confused',
            style: 'sketch',
            complexity: 'high'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: {
                    enabled: true,
                    updatedAt: '2026-05-20T09:00:00.000Z',
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        size: '72',
                        emotion: 'neutral',
                        style: 'robot-soft'
                    }
                }
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote',
                    webmeetProfileAvatar: JSON.stringify(liveAvatar)
                },
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].profileAvatar.config.size, '32');
    assert.equal(context.state.participants[1].profileAvatar.config.emotion, 'confused');
    assert.equal(appliedViews.get('participant-remote').profileAvatar.config.complexity, 'high');
});

test('syncParticipantsFromRoom preserves the current remote room avatar during routine resyncs', () => {
    const appliedViews = new Map();
    const staleLiveAvatar = {
        enabled: true,
        updatedAt: '2026-05-20T09:00:00.000Z',
        fallbackLetter: 'R',
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true,
            size: '64',
            emotion: 'speaking',
            style: 'sketch'
        }
    };
    const freshRealtimeAvatar = {
        enabled: true,
        updatedAt: '2026-05-20T10:00:00.000Z',
        fallbackLetter: 'R',
        config: {
            agentId: 'profile:local:remote',
            seed: 'profile:local:remote',
            generated: true,
            size: '72',
            emotion: 'neutral',
            style: 'terminal'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [{
                id: 'participant-remote',
                kind: 'remote',
                displayName: 'Remote User',
                userId: 'local:remote',
                attributes: {
                    webmeetUserId: 'local:remote'
                },
                profileAvatar: freshRealtimeAvatar
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {
                webmeetUserId: 'local:self'
            }
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {
                    webmeetUserId: 'local:remote',
                    webmeetProfileAvatar: JSON.stringify(staleLiveAvatar)
                },
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.deepEqual(context.state.participants[1].profileAvatar, freshRealtimeAvatar);
    assert.deepEqual(appliedViews.get('participant-remote').profileAvatar, freshRealtimeAvatar);
});

test('syncParticipantsFromRoom preserves the current local room avatar during routine resyncs', () => {
    const appliedViews = new Map();
    const staleLiveAvatar = {
        enabled: true,
        updatedAt: '2026-05-20T09:00:00.000Z',
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            seed: 'profile:local:admin',
            generated: true,
            size: '64',
            emotion: 'speaking',
            style: 'sketch'
        }
    };
    const freshLocalAvatar = {
        enabled: true,
        updatedAt: '2026-05-20T10:00:00.000Z',
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            seed: 'profile:local:admin',
            generated: true,
            size: '72',
            emotion: 'neutral',
            style: 'terminal'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Admin'
                }
            },
            participants: [{
                id: 'participant-local',
                kind: 'local',
                displayName: 'Admin',
                userId: 'local:admin',
                attributes: {
                    webmeetUserId: 'local:admin'
                },
                profileAvatar: freshLocalAvatar
            }],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Admin',
            attributes: {
                webmeetUserId: 'local:admin',
                webmeetProfileAvatar: JSON.stringify(staleLiveAvatar)
            }
        },
        remoteParticipants: new Map()
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.deepEqual(context.state.participants[0].profileAvatar, freshLocalAvatar);
    assert.deepEqual(appliedViews.get('participant-local').profileAvatar, freshLocalAvatar);
});

test('syncParticipantsFromRoom preserves a guest local avatar from the active session during media resyncs', () => {
    const appliedViews = new Map();
    const guestAvatar = {
        enabled: true,
        fallbackLetter: 'G',
        config: {
            agentId: 'profile:guest-alpha',
            seed: 'profile:guest-alpha',
            generated: true,
            size: '72',
            emotion: 'happy',
            style: 'robot-soft'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-guest',
                participant: {
                    id: 'participant-guest',
                    displayName: 'Guest Alpha',
                    profileAvatar: guestAvatar
                }
            },
            participants: [],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                profileAvatar: participant.profileAvatar || null
            });
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-guest',
            name: 'Guest Alpha',
            attributes: {}
        },
        remoteParticipants: new Map()
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.deepEqual(context.state.participants[0].profileAvatar, guestAvatar);
    assert.deepEqual(appliedViews.get('participant-guest').profileAvatar, guestAvatar);
});

test('syncParticipantsFromRoom propagates active speaker state to room roster', () => {
    const appliedViews = new Map();
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [],
            meetingParticipantsById: {},
            activeSpeakerIds: new Set(['participant-remote'])
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, participant);
            return {
                id,
                micOn: false
            };
        },
        applyParticipantViewState() {},
        isParticipantMicOn() {
            return false;
        },
        isParticipantSpeaking: participantViewMethods.isParticipantSpeaking,
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return { micOn: false, id };
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {}
        },
        remoteParticipants: new Map([
            ['participant-remote', {
                identity: 'participant-remote',
                name: 'Remote User',
                attributes: {},
                trackPublications: new Map()
            }]
        ])
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[0].isSpeaking, false);
    assert.equal(context.state.participants[1].isSpeaking, true);
    assert.equal(context.state.meetingParticipantsById['meeting-1'][0].isSpeaking, false);
    assert.equal(context.state.meetingParticipantsById['meeting-1'][1].isSpeaking, true);
});

test('isParticipantMicOn reads only microphone publication state', () => {
    const context = {
        ...participantViewMethods,
        state: {
            session: {
                participantIdentity: 'participant-local'
            }
        },
        room: {
            localParticipant: {
                identity: 'participant-local'
            }
        },
        mediaController: {
            activeMicrophoneCapture: null
        }
    };
    const Track = {
        Kind: { Audio: 'audio', Video: 'video' },
        Source: {
            Microphone: 'microphone',
            ScreenShareAudio: 'screen_share_audio'
        }
    };
    const participant = {
        identity: 'participant-remote',
        trackPublications: new Map()
    };

    participant.trackPublications.set('mic-on', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: false
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), true);

    participant.trackPublications.set('mic-on', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: true
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), false);

    participant.trackPublications.clear();
    participant.trackPublications.set('screen-audio', {
        kind: Track.Kind.Audio,
        source: Track.Source.ScreenShareAudio,
        isMuted: false
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), false);

    participant.trackPublications.set('mic-muted', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: true
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), false);

    participant.trackPublications.set('mic-unmuted', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: false
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), true);
});

test('syncParticipantsFromRoom initializes remote mic state from LiveKit publications', () => {
    const appliedViews = new Map();
    const context = {
        ...participantViewMethods,
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            participants: [],
            meetingParticipantsById: {},
            activeSpeakerIds: new Set()
        },
        selectedMeeting: { id: 'meeting-1' },
        room: null,
        mediaController: {
            activeMicrophoneCapture: null,
            syncLocalMediaStateFromRoom() {}
        },
        getAgentForParticipant() {
            return null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            const view = appliedViews.get(id) || { id, micOn: false };
            appliedViews.set(id, view);
            return view;
        },
        applyParticipantViewState(view) {
            appliedViews.set(view.id, { ...view });
        },
        participantLayoutController: {
            getParticipantIds() {
                return Array.from(appliedViews.keys());
            },
            getParticipantView(id) {
                return appliedViews.get(id) || null;
            }
        },
        removeParticipantView() {},
        renderMeetingList() {},
        renderParticipantLayout() {},
        syncLocalMediaStateFromRoom() {},
        renderFeedLists() {}
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: {
            Microphone: 'microphone',
            ScreenShareAudio: 'screen_share_audio'
        }
    };
    const room = {
        localParticipant: {
            identity: 'participant-local',
            name: 'Local User',
            attributes: {}
        },
        remoteParticipants: new Map([
            ['participant-mic-on', {
                identity: 'participant-mic-on',
                name: 'Mic On',
                attributes: {},
                trackPublications: new Map([
                    ['mic', {
                        kind: Track.Kind.Audio,
                        source: Track.Source.Microphone,
                        isMuted: false
                    }]
                ])
            }],
            ['participant-mic-off', {
                identity: 'participant-mic-off',
                name: 'Mic Off',
                attributes: {},
                trackPublications: new Map([
                    ['mic', {
                        kind: Track.Kind.Audio,
                        source: Track.Source.Microphone,
                        isMuted: true
                    }],
                    ['screen-audio', {
                        kind: Track.Kind.Audio,
                        source: Track.Source.ScreenShareAudio,
                        isMuted: false
                    }]
                ])
            }]
        ])
    };

    context.room = room;
    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(appliedViews.get('participant-mic-on')?.micOn, true);
    assert.equal(appliedViews.get('participant-mic-off')?.micOn, false);
    assert.equal(context.state.meetingParticipantsById['meeting-1'].find((entry) => entry.id === 'participant-mic-on')?.micOn, true);
    assert.equal(context.state.meetingParticipantsById['meeting-1'].find((entry) => entry.id === 'participant-mic-off')?.micOn, false);
});

test('applyRealtimeParticipantAvatar marks room avatar as projected state', () => {
    const view = {
        id: 'participant-local',
        avatarUserId: 'local:admin',
        avatarFallbackLetter: 'A'
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    userId: 'local:admin'
                }
            },
            participants: [{
                id: 'participant-local',
                identity: 'participant-local',
                userId: 'local:admin',
                attributes: {}
            }]
        },
        currentActor: {
            id: 'local:admin'
        },
        participantLayoutController: {
            getViews() {
                return [view];
            }
        },
        applyParticipantViewState() {}
    };
    const profileAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            style: 'sketch',
            size: '72'
        }
    };

    const changed = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-local',
        userId: 'local:admin',
        profileAvatar
    });

    assert.equal(changed, true);
    assert.equal(view.avatarSource, 'projected');
    assert.equal(view.avatarConfig.style, 'sketch');
    assert.equal(context.state.participants[0].profileAvatar.config.size, '72');
    assert.equal(context.state.participants[0].attributes.webmeetProfileAvatar, JSON.stringify(profileAvatar));
    assert.equal(context.state.session.participant.profileAvatar.config.style, 'sketch');
});
