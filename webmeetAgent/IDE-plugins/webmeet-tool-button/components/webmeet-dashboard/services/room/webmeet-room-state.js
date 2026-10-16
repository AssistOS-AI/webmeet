function cloneObject(value) {
    return JSON.parse(JSON.stringify(value));
}

function normalizeInitialState(initialState = {}) {
    const base = initialState && typeof initialState === 'object' && !Array.isArray(initialState)
        ? initialState
        : {};
    return {
        meeting: base.meeting && typeof base.meeting === 'object' ? { ...base.meeting } : null,
        session: base.session && typeof base.session === 'object' ? { ...base.session } : null,
        participants: Array.isArray(base.participants) ? [...base.participants] : [],
        chat: Array.isArray(base.chat) ? [...base.chat] : [],
        agents: Array.isArray(base.agents) ? [...base.agents] : [],
        resources: Array.isArray(base.resources) ? [...base.resources] : [],
        livekitState: String(base.livekitState || 'disconnected').trim() || 'disconnected',
        mediaState: base.mediaState && typeof base.mediaState === 'object'
            ? { ...base.mediaState }
            : { microphone: false, camera: false, screen: false },
        avatarsByParticipantId: base.avatarsByParticipantId && typeof base.avatarsByParticipantId === 'object'
            ? { ...base.avatarsByParticipantId }
            : {},
        workspaceId: String(base.workspaceId || '').trim(),
        roomName: String(base.roomName || '').trim(),
        meetingId: String(base.meetingId || '').trim(),
        participantId: String(base.participantId || '').trim(),
        guest: base.guest === true
    };
}

export class WebMeetRoomState {
    constructor(initialState = {}) {
        this.state = normalizeInitialState(initialState);
    }

    getSnapshot() {
        return cloneObject(this.state);
    }

    hydrateFromSession(session = null, guest = false) {
        const nextSession = session && typeof session === 'object' ? session : null;
        const meeting = nextSession?.meeting && typeof nextSession.meeting === 'object'
            ? { ...nextSession.meeting }
            : null;
        this.state.session = nextSession ? { ...nextSession } : null;
        this.state.meeting = meeting;
        this.state.meetingId = String(meeting?.id || meeting?.roomId || nextSession?.roomId || '').trim();
        this.state.workspaceId = String(meeting?.workspaceId || 'rooms').trim();
        this.state.roomName = String(nextSession?.roomName || meeting?.roomName || '').trim();
        this.state.participantId = String(nextSession?.participantIdentity || '').trim();
        this.state.guest = guest === true;
    }

    setLiveKitState(value) {
        this.state.livekitState = String(value || '').trim() || 'disconnected';
    }

    setChat(items = []) {
        this.state.chat = Array.isArray(items) ? [...items] : [];
    }

    setParticipants(items = []) {
        this.state.participants = Array.isArray(items) ? [...items] : [];
    }

    setAgents(items = []) {
        this.state.agents = Array.isArray(items) ? [...items] : [];
    }

    setResources(items = []) {
        this.state.resources = Array.isArray(items) ? [...items] : [];
    }

    setAvatar(participantId, avatar) {
        const id = String(participantId || '').trim();
        if (!id) {
            throw new Error('Missing room state participant id for avatar projection.');
        }
        if (!avatar || typeof avatar !== 'object' || Array.isArray(avatar)) {
            throw new Error('Invalid room state avatar payload.');
        }
        this.state.avatarsByParticipantId[id] = avatar;
    }

    clear() {
        this.state = normalizeInitialState({});
    }
}
