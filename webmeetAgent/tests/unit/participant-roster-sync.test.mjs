import { test } from 'node:test';
import assert from 'node:assert/strict';

import { participantViewMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/participant-view-methods.js';

test('syncParticipantsFromRoom preserves roster ids and projected avatars across repeated syncs', () => {
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
            participantProfileAvatarsByUserId: {},
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
    assert.equal(context.state.participants[1].profileAvatar?.config?.seed, 'profile:local:remote');

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[1].id, 'participant-remote');
    assert.equal(context.state.participants[1].userId, 'local:remote');
    assert.equal(context.state.participants[1].profileAvatar?.config?.seed, 'profile:local:remote');
});

test('syncParticipantsFromRoom restores remote avatar by user id after leave and rejoin', () => {
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
            participantProfileAvatarsByUserId: {},
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
    assert.equal(context.state.participantProfileAvatarsByUserId['local:remote']?.config?.seed, 'profile:local:remote');

    participantViewMethods.syncParticipantsFromRoom.call(context, rejoinedRoom, Track);

    assert.equal(context.state.participants[1].id, 'participant-remote-new');
    assert.equal(context.state.participants[1].userId, 'local:remote');
    assert.equal(context.state.participants[1].profileAvatar?.config?.seed, 'profile:local:remote');
    assert.equal(appliedViews.get('participant-remote-new')?.profileAvatar?.config?.seed, 'profile:local:remote');
});

test('applyRealtimeParticipantAvatar updates cached remote avatar size by user id', () => {
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
            participantProfileAvatarsByUserId: {
                'local:remote': {
                    enabled: true,
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        generated: true,
                        size: '48'
                    }
                }
            }
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
    assert.equal(context.state.participantProfileAvatarsByUserId['local:remote'].config.size, '96');
    assert.equal(appliedViews[0].avatarConfig.size, '96');
});

test('cacheParticipantProfileAvatars stores roster avatar sizes by user id', () => {
    const context = {
        state: {
            participantProfileAvatarsByUserId: {}
        }
    };

    participantViewMethods.cacheParticipantProfileAvatars.call(context, [{
        id: 'participant-remote',
        userId: 'local:remote',
        attributes: {
            webmeetUserId: 'local:remote'
        },
        profileAvatar: {
            enabled: true,
            config: {
                agentId: 'profile:local:remote',
                seed: 'profile:local:remote',
                size: '88'
            }
        }
    }]);

    assert.equal(context.state.participantProfileAvatarsByUserId['local:remote'].config.size, '88');
});

test('syncParticipantsFromRoom keeps newer cached avatar size over older participant state', () => {
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
            participantProfileAvatarsByUserId: {
                'local:remote': {
                    enabled: true,
                    updatedAt: '2026-05-19T10:00:05.000Z',
                    config: {
                        agentId: 'profile:local:remote',
                        seed: 'profile:local:remote',
                        size: '96'
                    }
                }
            },
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

    assert.equal(context.state.participants[1].profileAvatar.config.size, '96');
    assert.equal(appliedViews.get('participant-remote').profileAvatar.config.size, '96');
});
