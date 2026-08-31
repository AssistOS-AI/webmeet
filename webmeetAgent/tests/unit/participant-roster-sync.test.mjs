import { test } from 'node:test';
import assert from 'node:assert/strict';

import { participantViewMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/participant-view-methods.js';

test('syncParticipantsFromRoom keeps active RoboTeam agent in connected room roster', () => {
    const appliedViews = new Map();
    const roboTeamAgent = {
        id: 'agent_robo_team',
        participantIdentity: 'agent_robo_team',
        agentType: 'robo_team',
        mode: 'blackboard_demo',
        agentName: 'Robo Team',
        runtime: 'ploinky',
        status: 'active'
    };
    const context = {
        state: {
            session: {
                meeting: { id: 'meeting-1' },
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Local User'
                }
            },
            selectedMeetingId: 'meeting-1',
            participants: [],
            agents: [roboTeamAgent],
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        getAgentForParticipant(participant) {
            const identity = String(participant?.identity || '').trim();
            return identity === 'agent_robo_team' ? roboTeamAgent : null;
        },
        upsertParticipantView(participant) {
            const id = String(participant?.identity || '').trim();
            appliedViews.set(id, {
                id,
                name: participant?.name || participant?.displayName || '',
                kind: participant?.kind || ''
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
        removeParticipantView(participantId) {
            appliedViews.delete(participantId);
        },
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
        remoteParticipants: new Map()
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, null);

    assert.deepEqual(
        context.state.participants.map((entry) => entry.id),
        ['participant-local', 'agent_robo_team']
    );
    assert.equal(context.state.participants[1].kind, 'agent');
    assert.equal(appliedViews.get('agent_robo_team')?.name, 'Robo Team');
    assert.equal(context.state.meetingParticipantsById['meeting-1'][1].isAgent, true);
});

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
        applyParticipantAvatarState(view) {
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
    assert.equal(context.state.participants[0].profileAvatar.config.size, '48');
    assert.equal(context.state.roomAvatarsByParticipantId['participant-remote'].config.size, '96');
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
        applyParticipantAvatarState(view) {
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
    assert.equal(context.state.participants[0].profileAvatar.config.size, '96');
    assert.equal(context.state.roomAvatarsByParticipantId['participant-remote'].config.size, '48');
    assert.equal(appliedViews[0].avatarConfig.size, '48');
});

test('applyRealtimeParticipantAvatar rejects a delayed avatar projection sequence', () => {
    const context = {
        state: {
            participants: [],
            roomAvatarsByParticipantId: {},
            avatarProjectionSequencesByParticipantId: {}
        },
        participantLayoutController: {
            getViews: () => [],
            getParticipantView: () => null
        }
    };
    const current = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        sequence: 8,
        profileAvatar: {
            enabled: true,
            config: { agentId: 'profile:remote', emotion: 'happy' },
            runtimeState: { emotion: 'happy', speaking: true, intensity: 0.8 }
        }
    });
    const delayed = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        sequence: 7,
        profileAvatar: {
            enabled: true,
            config: { agentId: 'profile:remote', emotion: 'neutral' },
            runtimeState: { emotion: 'neutral', speaking: false, intensity: 0 }
        }
    });

    assert.equal(current, true);
    assert.equal(delayed, false);
    assert.equal(context.state.roomAvatarsByParticipantId['participant-remote'].runtimeState.emotion, 'happy');
    assert.equal(context.state.avatarProjectionSequencesByParticipantId['participant-remote'], 8);
});

test('LiveKit base avatar attributes cannot erase the sequenced audio runtime state', () => {
    const context = {
        state: {
            participants: [],
            roomAvatarsByParticipantId: {
                'participant-remote': {
                    enabled: true,
                    config: { agentId: 'profile:remote', expressionMode: 'audio' },
                    runtimeState: { emotion: 'happy', speaking: true, intensity: 0.8 }
                }
            }
        },
        participantLayoutController: {
            getViews: () => [],
            getParticipantView: () => null
        }
    };

    participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        preserveRuntimeState: true,
        profileAvatar: {
            enabled: true,
            config: { agentId: 'profile:remote', expressionMode: 'audio' }
        }
    });

    assert.equal(context.state.roomAvatarsByParticipantId['participant-remote'].runtimeState.emotion, 'happy');
    assert.equal(context.state.roomAvatarsByParticipantId['participant-remote'].runtimeState.speaking, true);

    participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-remote',
        preserveRuntimeState: true,
        profileAvatar: {
            enabled: true,
            config: { agentId: 'profile:remote', expressionMode: 'manual', emotion: 'amused' }
        }
    });
    assert.equal('runtimeState' in context.state.roomAvatarsByParticipantId['participant-remote'], false);
});

test('applyRealtimeParticipantAvatar reconciles a stale projected view after the room map was updated first', () => {
    const speakingAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            emotion: 'neutral',
            expressionMode: 'audio'
        },
        runtimeState: {
            emotion: 'speaking',
            intensity: 0.5,
            speaking: true
        }
    };
    const neutralAvatar = {
        ...speakingAvatar,
        runtimeState: {
            emotion: 'neutral',
            intensity: 0.3,
            speaking: false
        }
    };
    const view = {
        id: 'participant-local',
        avatarUserId: 'local:admin',
        avatarEnabled: true,
        avatarResolved: true,
        avatarSource: 'projected',
        avatarFallbackLetter: 'A',
        avatarConfig: {
            ...speakingAvatar.config,
            emotion: 'speaking'
        },
        avatarRuntimeState: speakingAvatar.runtimeState,
        avatarProjectionKey: JSON.stringify({
            enabled: true,
            config: {
                ...speakingAvatar.config,
                emotion: 'speaking'
            },
            runtimeState: speakingAvatar.runtimeState,
            fallbackLetter: 'A'
        })
    };
    const appliedViews = [];
    const context = {
        state: {
            roomAvatarsByParticipantId: {
                'participant-local': neutralAvatar
            },
            session: {
                participantIdentity: 'participant-local',
                participant: { userId: 'local:admin' }
            },
            participants: [{
                id: 'participant-local',
                identity: 'participant-local',
                userId: 'local:admin',
                attributes: {}
            }]
        },
        currentActor: { id: 'local:admin' },
        participantLayoutController: {
            getViews() {
                return [view];
            }
        },
        applyParticipantAvatarState(nextView) {
            appliedViews.push({ ...nextView });
        }
    };

    const changed = participantViewMethods.applyRealtimeParticipantAvatar.call(context, {
        participantId: 'participant-local',
        userId: 'local:admin',
        profileAvatar: neutralAvatar
    });

    assert.equal(changed, true);
    assert.equal(appliedViews.length, 1);
    assert.equal(view.avatarRuntimeState.emotion, 'neutral');
    assert.equal(view.avatarRuntimeState.speaking, false);
    assert.equal(view.avatarConfig.emotion, 'neutral');
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
            roomAvatarsByParticipantId: {
                'participant-remote': freshRealtimeAvatar
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
        },
        runtimeState: {
            emotion: 'happy',
            intensity: 0.8,
            speaking: true
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
            roomAvatarsByParticipantId: {
                'participant-local': freshLocalAvatar
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

test('syncParticipantsFromRoom keeps the browser override as the active local avatar during media resyncs', () => {
    const appliedViews = new Map();
    const profileAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            seed: 'profile:local:admin',
            generated: true,
            style: 'terminal',
            emotion: 'neutral'
        }
    };
    const liveKitAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        config: {
            agentId: 'profile:local:admin',
            seed: 'profile:local:admin',
            generated: true,
            style: 'sketch',
            emotion: 'speaking'
        }
    };
    const override = {
        config: {
            agentId: 'profile:local:admin',
            seed: 'profile:local:admin',
            generated: true,
            sourceMode: 'generated',
            style: 'emoji',
            emotion: 'happy',
            size: '88'
        }
    };
    const projectedOverrideAvatar = {
        enabled: true,
        fallbackLetter: 'A',
        config: {
            ...override.config
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-local',
                participant: {
                    displayName: 'Admin',
                    profileAvatar
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
                profileAvatar
            }],
            webMeetAvatarOverride: override,
            roomAvatarsByParticipantId: {
                'participant-local': projectedOverrideAvatar
            },
            meetingParticipantsById: {}
        },
        selectedMeeting: { id: 'meeting-1' },
        webMeetRoom: {
            buildAvatarProjection(sourceAvatar) {
                return {
                    enabled: sourceAvatar?.enabled !== false,
                    fallbackLetter: sourceAvatar?.fallbackLetter || '',
                    config: sourceAvatar?.config || null
                };
            }
        },
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
                webmeetProfileAvatar: JSON.stringify(liveKitAvatar)
            }
        },
        remoteParticipants: new Map()
    };
    const Track = {
        Kind: { Audio: 'audio' },
        Source: { Microphone: 'microphone' }
    };

    participantViewMethods.syncParticipantsFromRoom.call(context, room, Track);

    assert.equal(context.state.participants[0].profileAvatar.config.style, 'emoji');
    assert.equal(context.state.participants[0].profileAvatar.config.emotion, 'happy');
    assert.equal(appliedViews.get('participant-local').profileAvatar.config.style, 'emoji');
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
            roomAvatarsByParticipantId: {
                'participant-guest': guestAvatar
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

test('syncParticipantsFromRoom restores a guest local avatar when the existing local roster entry has no avatar', () => {
    const appliedViews = new Map();
    const guestAvatar = {
        enabled: true,
        fallbackLetter: 'G',
        config: {
            agentId: 'profile:guest-beta',
            seed: 'profile:guest-beta',
            generated: true,
            size: '64',
            emotion: 'thinking',
            style: 'sketch'
        }
    };
    const context = {
        state: {
            session: {
                participantIdentity: 'participant-guest',
                participant: {
                    id: 'participant-guest',
                    displayName: 'Guest Beta',
                    profileAvatar: guestAvatar
                }
            },
            participants: [{
                id: 'participant-guest',
                identity: 'participant-guest',
                kind: 'local',
                displayName: 'Guest Beta',
                attributes: {}
            }],
            roomAvatarsByParticipantId: {
                'participant-guest': guestAvatar
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
            identity: 'participant-guest',
            name: 'Guest Beta',
            attributes: {},
            trackPublications: new Map()
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

    participant.trackPublications.set('mic-unmuted', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: false,
        track: { isMuted: true }
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), false);

    participant.trackPublications.set('mic-unmuted', {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: false,
        track: {
            mediaStreamTrack: {
                enabled: false,
                readyState: 'live'
            }
        }
    });
    assert.equal(participantViewMethods.isParticipantMicOn.call(context, participant, Track), false);
});

test('voice-responsive avatar rejects stale active-speaker state after microphone mute', () => {
    const Track = {
        Kind: { Audio: 'audio', Video: 'video' },
        Source: { Microphone: 'microphone' }
    };
    const microphonePublication = {
        kind: Track.Kind.Audio,
        source: Track.Source.Microphone,
        isMuted: false,
        track: {
            isMuted: false,
            mediaStreamTrack: {
                enabled: true,
                readyState: 'live'
            }
        }
    };
    const localParticipant = {
        identity: 'participant-local',
        trackPublications: new Map([['microphone', microphonePublication]])
    };
    const activity = [];
    const context = {
        ...participantViewMethods,
        state: {
            session: { participantIdentity: 'participant-local' },
            activeSpeakerIds: new Set(['participant-local'])
        },
        room: {
            localParticipant,
            remoteParticipants: new Map()
        },
        mediaController: { activeMicrophoneCapture: null },
        syncParticipantsFromRoom() {},
        voiceResponsiveAvatarController: {
            setLiveKitState(value) {
                activity.push(value);
            }
        }
    };

    participantViewMethods.syncVoiceResponsiveAvatar.call(context, Track);
    microphonePublication.isMuted = true;
    participantViewMethods.syncVoiceResponsiveAvatar.call(context, Track);
    participantViewMethods.setActiveSpeakers.call(context, [localParticipant], Track);

    assert.deepEqual(activity, [
        {
            localSpeaking: true,
            remoteSpeaking: false,
            microphoneAvailable: true,
            microphoneTrack: microphonePublication.track.mediaStreamTrack
        },
        {
            localSpeaking: false,
            remoteSpeaking: false,
            microphoneAvailable: false,
            microphoneTrack: null
        },
        { localSpeaking: false, remoteSpeaking: false }
    ]);
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
        applyParticipantAvatarState() {}
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
    assert.equal(context.state.participants[0].profileAvatar, undefined);
    assert.equal(context.state.participants[0].attributes.webmeetProfileAvatar, undefined);
    assert.equal(context.state.roomAvatarsByParticipantId['participant-local'].config.size, '72');
});
