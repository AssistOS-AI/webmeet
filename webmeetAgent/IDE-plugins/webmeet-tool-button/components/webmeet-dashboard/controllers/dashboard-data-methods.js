import { runWebMeetTool } from '../services/webmeet-api-client.js';
import { isMissingMeetingError } from '../services/dashboard-utils.js';
import { WEBMEET_EVENT_TYPES, parseWebMeetEvent } from '../services/webmeet-events.js';

const runTool = runWebMeetTool;
const MEETING_GET_CACHE_TTL_MS = 1500;

export const dashboardDataMethods = {
    getMeetingGetCacheKey(meetingId, includeParticipants = false) {
        const normalizedMeetingId = String(meetingId || '').trim();
        return `${normalizedMeetingId}:${includeParticipants ? 'participants' : 'summary'}`;
    },

    clearMeetingGetCache(meetingId = '') {
        const normalizedMeetingId = String(meetingId || '').trim();
        if (!this.meetingGetCache) {
            this.meetingGetCache = new Map();
            return;
        }
        if (!normalizedMeetingId) {
            this.meetingGetCache.clear();
            return;
        }
        for (const key of this.meetingGetCache.keys()) {
            if (key.startsWith(`${normalizedMeetingId}:`)) {
                this.meetingGetCache.delete(key);
            }
        }
    },

    async fetchMeetingSnapshot(meetingId, options = {}) {
        const normalizedMeetingId = String(meetingId || '').trim();
        if (!normalizedMeetingId) {
            throw new Error('Missing meetingId.');
        }
        if (!this.meetingGetCache) {
            this.meetingGetCache = new Map();
        }
        const includeParticipants = options.includeParticipants === true;
        const force = options.force === true;
        const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
            ? Number(options.ttlMs)
            : MEETING_GET_CACHE_TTL_MS;
        const cacheKey = this.getMeetingGetCacheKey(normalizedMeetingId, includeParticipants);
        const cached = !force ? this.meetingGetCache.get(cacheKey) : null;
        const now = Date.now();
        if (cached?.promise) {
            return cached.promise;
        }
        if (cached && Object.prototype.hasOwnProperty.call(cached, 'value') && (now - cached.timestamp) < ttlMs) {
            return cached.value;
        }
        const requestPromise = runTool('webmeet_room_get', {
            roomId: normalizedMeetingId,
            includeParticipants
        })
            .then((value) => {
                if (this.webMeetRoom?.disposed || this.meetingGetCache.get(cacheKey)?.promise !== requestPromise) return value;
                this.meetingGetCache.set(cacheKey, {
                    value,
                    timestamp: Date.now(),
                    promise: null
                });
                return value;
            })
            .catch((error) => {
                if (this.meetingGetCache.get(cacheKey)?.promise === requestPromise) this.meetingGetCache.delete(cacheKey);
                throw error;
            });
        this.meetingGetCache.set(cacheKey, {
            value: cached?.value,
            timestamp: cached?.timestamp || 0,
            promise: requestPromise
        });
        return requestPromise;
    },

    async loadMeetings(options = {}) {
        if (this.webMeetRoom?.disposed) return null;
        const loadSeq = (this.meetingListLoadSeq || 0) + 1;
        this.meetingListLoadSeq = loadSeq;
        const workspaceId = this.webMeetRoom?.getSelectedWorkspaceId?.();
        const current = () => !this.webMeetRoom?.disposed && loadSeq === this.meetingListLoadSeq
            && workspaceId === this.webMeetRoom?.getSelectedWorkspaceId?.()
            && (!options.revalidateVisibility || !this.isGuestSession());
        const payload = await runTool('webmeet_room_list');
        if (!current()) return null;
        if (!Array.isArray(payload?.meetings)) throw new Error('Invalid room directory response.');
        this.state.meetings = payload.meetings;
        this.state.canManageRooms = payload.canManageRooms === true;
        const visibleIds = new Set(payload.meetings.map((meeting) => meeting.id));
        for (const id of Object.keys(this.state.meetingParticipantsById || {})) {
            if (!visibleIds.has(id)) delete this.state.meetingParticipantsById[id];
        }
        for (const key of this.meetingGetCache?.keys?.() || []) {
            if (!visibleIds.has(key.split(':')[0])) this.meetingGetCache.delete(key);
        }
        if (!visibleIds.has(this.state.selectedMeetingId)) {
            this.state.selectedMeetingId = '';
            this.state.participants = [];
            this.state.chat = [];
            this.state.resources = [];
            this.state.agents = [];
        }
        if (options.revalidateVisibility) return payload.meetings;
        const selectedMeetingId = this.state.selectedMeetingId;
        const loadParticipants = options.loadParticipants !== false;
        // The selected room's roster snapshot carries the same post-reconcile agents as a
        // summary room_get, so the details load reuses it within this load instead of
        // issuing a second call. It is always fetched fresh, never from meetingGetCache.
        const detailsSnapshot = loadParticipants && this.canReuseRosterForDetails(selectedMeetingId, options)
            ? this.fetchMeetingSnapshot(selectedMeetingId, { includeParticipants: true, force: true })
            : null;
        const participantsLoad = loadParticipants
            ? this.loadParticipantsForMeetings({
                ...options,
                isCurrent: current,
                meetingSnapshots: detailsSnapshot ? new Map([[selectedMeetingId, detailsSnapshot]]) : null
            })
            : Promise.resolve();
        // Details calls run alongside the rosters; their state is applied after the
        // roster pass, as before, and only while this load is current.
        const detailsLoad = selectedMeetingId
            ? this.loadMeetingDetails({
                expectedMeetingId: selectedMeetingId,
                includeParticipants: false,
                detailsSnapshot,
                afterRoster: participantsLoad,
                isCurrent: current
            })
            : Promise.resolve();
        await Promise.all([participantsLoad, detailsLoad]);
        if (!current()) return null;
        this.state.selectedMeetingId = this.state.meetings.some((entry) => entry.id === this.state.selectedMeetingId)
            ? this.state.selectedMeetingId
            : '';
        return current() ? payload.meetings : null;
    },

    // True when loadParticipantsForMeetings would fetch this room's roster anyway.
    canReuseRosterForDetails(meetingId, options = {}) {
        const targetMeetingId = String(meetingId || '').trim();
        if (!targetMeetingId || this.isGuestSession()) return false;
        if (!Array.isArray(options.rosterMeetingIds)) return true;
        return options.rosterMeetingIds.some((entry) => String(entry || '').trim() === targetMeetingId)
            || !Array.isArray(this.state.meetingParticipantsById?.[targetMeetingId]);
    },

    async refreshMeetingsFromWorkspaceEvent() {
        if (this.isGuestSession() || this.webMeetRoom.disposed || this.workspaceVisibilityRefreshInFlight) return;
        this.workspaceVisibilityRefreshInFlight = true;
        const captured = this.webMeetRoom.captureSession();
        const version = this.webMeetRoom.workspaceInvalidationVersion;
        const workspaceId = this.webMeetRoom.getSelectedWorkspaceId();
        try {
            const meetings = await this.loadMeetings({ revalidateVisibility: true });
            if (!meetings || this.webMeetRoom.disposed || workspaceId !== this.webMeetRoom.getSelectedWorkspaceId()) return;
            this.webMeetRoom.workspaceReconciledVersion = version;
            const joined = meetings.find((meeting) => meeting.id === captured.meetingId);
            if (captured.participantId && this.webMeetRoom.isSessionCurrent(captured)
                && (!joined || joined.status === 'archived' || joined.archivedAt)) {
                await this.leaveMeeting({ expectedSession: captured });
                if (this.webMeetRoom.disposed) return;
                // A queued replacement may already be installed after cleanup.
                if (!this.state.session?.participantIdentity) this.setError('This room is no longer available.');
            }
            if (!this.webMeetRoom.disposed) this.renderAll();
        } finally {
            this.workspaceVisibilityRefreshInFlight = false;
        }
    },

    async refreshWorkspaceRosterFromEvent(meetingIds = []) {
        if (this.isGuestSession() || !this.state.meetings.length) return;
        await this.loadMeetings({
            preserveConnectedRoomRoster: true,
            rosterMeetingIds: Array.isArray(meetingIds) ? meetingIds : []
        });
        if (this.webMeetRoom?.disposed) return;
        this.renderMeetingList();
        this.renderMeetingSummary();
    },

    async refreshMeetingDetailsFromRealtimeEvent() {
        const selectedMeetingId = String(this.state.selectedMeetingId || '').trim();
        try {
            await this.loadMeetingDetails({
                expectedMeetingId: selectedMeetingId,
                includeParticipants: false
            });
            this.renderAll();
        } catch (_) {
            // Realtime events are best-effort; direct user actions still surface failures.
        }
    },

    runBestEffortRealtimeRefresh(refreshFn) {
        void Promise.resolve()
            .then(() => refreshFn())
            .catch(() => {
                // Avoid unhandled promise rejections for transient MCP/session resets.
            });
    },

    scheduleWorkspaceMeetingsRefresh() {
        if (this.webMeetRoom?.disposed || this.workspaceMeetingsRefreshTimer || this.workspaceVisibilityRefreshInFlight) return;
        this.workspaceMeetingsRefreshTimer = window.setTimeout(() => {
            this.workspaceMeetingsRefreshTimer = null;
            this.runBestEffortRealtimeRefresh(() => this.refreshMeetingsFromWorkspaceEvent());
        }, 100);
    },

    scheduleWorkspaceRosterRefresh(meetingId = '') {
        if (this.webMeetRoom?.disposed) return;
        const normalizedMeetingId = String(meetingId || '').trim();
        if (normalizedMeetingId) {
            this.pendingWorkspaceRosterRefreshMeetingIds ??= new Set();
            this.pendingWorkspaceRosterRefreshMeetingIds.add(normalizedMeetingId);
        }
        this.clearWorkspaceRosterRefreshTimer();
        this.workspaceRosterRefreshTimer = window.setTimeout(() => {
            const rosterMeetingIds = Array.from(this.pendingWorkspaceRosterRefreshMeetingIds || []);
            this.pendingWorkspaceRosterRefreshMeetingIds?.clear?.();
            this.workspaceRosterRefreshTimer = null;
            this.runBestEffortRealtimeRefresh(() => this.refreshWorkspaceRosterFromEvent(rosterMeetingIds));
        }, 100);
    },

    clearWorkspaceMeetingsRefreshTimer() {
        if (!this.workspaceMeetingsRefreshTimer) return;
        window.clearTimeout(this.workspaceMeetingsRefreshTimer);
        this.workspaceMeetingsRefreshTimer = null;
    },

    clearWorkspaceRosterRefreshTimer() {
        if (!this.workspaceRosterRefreshTimer) return;
        window.clearTimeout(this.workspaceRosterRefreshTimer);
        this.workspaceRosterRefreshTimer = null;
    },

    async refreshMeetingsAfterMissingMeeting(missingMeetingId) {
        const payload = await runTool('webmeet_room_list');
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.canManageRooms = payload.canManageRooms === true;
        await this.loadParticipantsForMeetings();
        return this.state.meetings.some((entry) => entry.id === missingMeetingId);
    },

    async fetchPublicMeetingDetails(meetingId) {
        return this.webMeetRoom.loadGuestRoomState(meetingId);
    },

    async loadParticipantsForMeetings(options = {}) {
        const current = () => !this.webMeetRoom?.disposed && (!options.isCurrent || options.isCurrent());
        if (!current()) return;
        const meetings = Array.isArray(this.state.meetings) ? this.state.meetings : [];
        const preserveConnectedRoomRoster = Boolean(options.preserveConnectedRoomRoster);
        const rosterMeetingIds = Array.isArray(options.rosterMeetingIds)
            ? new Set(options.rosterMeetingIds.map((meetingId) => String(meetingId || '').trim()).filter(Boolean))
            : null;
        const connectedMeetingId = preserveConnectedRoomRoster && (this.room || this.state.roomState === 'Connected')
            ? String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim()
            : '';
        const connectedRoster = connectedMeetingId && Array.isArray(this.state.meetingParticipantsById?.[connectedMeetingId])
            ? this.state.meetingParticipantsById[connectedMeetingId]
            : null;
        const mapMeetingRoster = (details, meetingId) => {
            const participants = Array.isArray(details?.participants) ? details.participants : [];
            const agents = Array.isArray(details?.agents)
                ? details.agents.filter((entry) => entry && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped')
                : [];
            const previousRoster = Array.isArray(this.state.meetingParticipantsById?.[meetingId])
                ? this.state.meetingParticipantsById[meetingId]
                : [];
            const previousMicStateById = new Map(
                previousRoster.map((entry) => [String(entry?.id || '').trim(), entry?.micOn])
            );
            const roster = participants.map((entry) => ({
                id: String(entry?.id || '').trim(),
                name: String(entry?.displayName || entry?.id || 'Participant').trim() || 'Participant',
                micOn: typeof entry?.micOn === 'boolean'
                    ? entry.micOn
                    : (typeof previousMicStateById.get(String(entry?.id || '').trim()) === 'boolean'
                        ? previousMicStateById.get(String(entry?.id || '').trim())
                        : false),
                isAgent: false
            })).filter((entry) => entry.id);
            for (const agent of agents) {
                const participantIdentity = String(agent?.participantIdentity || agent?.participant?.identity || '').trim();
                if (!participantIdentity || roster.some((entry) => entry.id === participantIdentity)) {
                    continue;
                }
                const label = String(
                    agent?.participant?.name
                    || agent?.participant?.identity
                    || agent?.agentType
                    || 'AI Agent'
                ).trim() || 'AI Agent';
                roster.push({
                    id: participantIdentity,
                    name: `${label} (AI)`,
                    micOn: typeof previousMicStateById.get(participantIdentity) === 'boolean'
                        ? previousMicStateById.get(participantIdentity)
                        : false,
                    isAgent: true
                });
            }
            return roster;
        };
        if (this.isGuestSession()) {
            const meeting = meetings[0];
            if (meeting?.id) {
                try {
                    const details = await this.fetchPublicMeetingDetails(meeting.id);
                    if (!current()) return;
                    this.state.meetingParticipantsById = {
                        [meeting.id]: mapMeetingRoster(details, meeting.id)
                    };
                } catch (error) {
                    if (!current()) return;
                    this.state.meetingParticipantsById = {};
                }
            } else {
                this.state.meetingParticipantsById = {};
            }
            return;
        }
        const results = await Promise.allSettled(
            meetings.map((meeting) => {
                const meetingId = String(meeting?.id || '').trim();
                const shouldRefreshMeeting = !rosterMeetingIds || rosterMeetingIds.has(meetingId);
                const hasCachedRoster = Array.isArray(this.state.meetingParticipantsById?.[meetingId]);
                if (!shouldRefreshMeeting && hasCachedRoster) {
                    return Promise.resolve(null);
                }
                const reusedSnapshot = options.meetingSnapshots?.get?.(meetingId);
                if (reusedSnapshot) {
                    return reusedSnapshot;
                }
                return this.fetchMeetingSnapshot(meetingId, {
                    includeParticipants: true,
                    force: Boolean(rosterMeetingIds?.has(meetingId))
                });
            })
        );
        const nextMap = {};
        if (!current()) return;
        const missingMeetingIds = new Set();
        for (let index = 0; index < meetings.length; index += 1) {
            const meeting = meetings[index];
            const result = results[index];
            const meetingId = String(meeting?.id || '').trim();
            const previousRoster = Array.isArray(this.state.meetingParticipantsById?.[meetingId])
                ? this.state.meetingParticipantsById[meetingId]
                : [];
            if (connectedMeetingId && String(meeting?.id || '').trim() === connectedMeetingId && connectedRoster) {
                nextMap[meeting.id] = connectedRoster;
                continue;
            }
            if (result.status === 'fulfilled' && result.value === null && previousRoster.length) {
                nextMap[meeting.id] = previousRoster;
                continue;
            }
            if (result.status !== 'fulfilled') {
                if (isMissingMeetingError(result.reason)) {
                    missingMeetingIds.add(String(meeting.id || '').trim());
                }
                nextMap[meeting.id] = [];
                continue;
            }
            nextMap[meeting.id] = mapMeetingRoster(result.value, meeting.id);
        }
        if (missingMeetingIds.size) {
            this.state.meetings = meetings.filter((entry) => !missingMeetingIds.has(String(entry?.id || '').trim()));
            for (const meetingId of missingMeetingIds) {
                delete nextMap[meetingId];
            }
            if (missingMeetingIds.has(String(this.state.selectedMeetingId || '').trim())) {
                this.state.selectedMeetingId = '';
                this.state.participants = [];
                this.state.chat = [];
                this.state.resources = [];
                this.state.agents = [];
                this.state.session = null;
            }
        }
        this.state.meetingParticipantsById = nextMap;
    },

    async loadMeetingDetails(options = {}) {
        if (this.webMeetRoom?.disposed) return;
        const expectedMeetingId = String(options.expectedMeetingId || this.state.selectedMeetingId || '').trim();
        const includeParticipants = this.isGuestSession()
            ? (options.includeParticipants === true || options.includeParticipants !== false)
            : false;
        const loadSeq = this.meetingDetailsLoadSeq + 1;
        this.meetingDetailsLoadSeq = loadSeq;
        const meeting = this.selectedMeeting;
        if (meeting && expectedMeetingId && meeting.id !== expectedMeetingId) {
            return;
        }
        if (!meeting) {
            if (expectedMeetingId && this.state.meetings.some((entry) => entry.id === expectedMeetingId)) {
                return;
            }
            this.state.chat = [];
            this.state.resources = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            this.state.participantAudioSettings = {};
            return;
        }
        this.loadParticipantAudioSettings();
        if (this.isGuestSession()) {
            if (options.afterRoster && !(await options.afterRoster.then(() => true, () => false))) return;
            try {
                const details = await this.fetchPublicMeetingDetails(meeting.id);
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                if (includeParticipants) {
                    this.state.participants = Array.isArray(details?.participants) ? details.participants : [];
                }
                this.state.chat = Array.isArray(details?.chat) ? details.chat : [];
                this.state.resources = Array.isArray(details?.resources) ? details.resources : [];
                this.state.agents = Array.isArray(details?.agents) ? details.agents : [];
            } catch (error) {
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                if (includeParticipants) {
                    this.state.participants = [];
                }
                this.state.chat = [];
                this.state.resources = [];
                this.state.agents = [];
            }
            return;
        }
        let detailsPayload = null;
        let chatPayload;
        let resourcePayload = { resources: [] };
        let agentPayload = { agents: [] };
        const isStale = () => loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id
            || (typeof options.isCurrent === 'function' && !options.isCurrent());
        const canManageMeetingData = this.canManageRooms();
        // A reused roster snapshot that failed (LiveKit or room lock) falls back to the
        // summary room_get, so a roster failure never fails the details load.
        const detailsRequest = options.detailsSnapshot
            ? options.detailsSnapshot.catch(() => this.fetchMeetingSnapshot(meeting.id, { includeParticipants }))
            : this.fetchMeetingSnapshot(meeting.id, { includeParticipants });
        const [detailsOutcome, chatOutcome, resourceOutcome] = await Promise.allSettled([
            detailsRequest,
            runTool('webmeet_chat_list', { meetingId: meeting.id }),
            canManageMeetingData ? runTool('webmeet_resource_list', { meetingId: meeting.id }) : resourcePayload
        ]);
        if (options.afterRoster && !(await options.afterRoster.then(() => true, () => false))) return;
        if (isStale()) return;
        try {
            // The room_get outcome decides first, as when the calls ran in sequence.
            for (const outcome of [detailsOutcome, chatOutcome, resourceOutcome]) {
                if (outcome.status === 'rejected') throw outcome.reason;
            }
            detailsPayload = detailsOutcome.value;
            chatPayload = chatOutcome.value;
            resourcePayload = resourceOutcome.value;
            if (canManageMeetingData) {
                agentPayload = { agents: Array.isArray(detailsPayload?.agents) ? detailsPayload.agents : [] };
            }
        } catch (error) {
            if (isStale()) return;
            if (!isMissingMeetingError(error)) {
                throw error;
            }
            const stillListed = await this.refreshMeetingsAfterMissingMeeting(meeting.id);
            if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
            if (stillListed) {
                return;
            }
            this.state.meetings = this.state.meetings.filter((entry) => entry.id !== meeting.id);
            this.state.selectedMeetingId = '';
            this.state.chat = [];
            this.state.resources = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            this.state.participantAudioSettings = {};
            this.setError('Room is no longer available. Refreshing rooms.');
            return;
        }
        if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
        if (includeParticipants) {
            this.state.participants = Array.isArray(detailsPayload?.participants) ? detailsPayload.participants : [];
        }
        this.state.chat = Array.isArray(chatPayload.messages) ? chatPayload.messages : [];
        this.state.resources = Array.isArray(resourcePayload.resources) ? resourcePayload.resources : [];
        this.state.agents = Array.isArray(agentPayload.agents) ? agentPayload.agents : [];
    },

    applyMeetingRename(meetingId, title, updatedAt = '') {
        const targetMeetingId = String(meetingId || '').trim();
        const nextTitle = String(title || '').trim();
        if (!targetMeetingId || !nextTitle) return false;
        let changed = false;
        const updateEntry = (entry) => {
            if (!entry || String(entry.id || '').trim() !== targetMeetingId) return;
            if (entry.title !== nextTitle) {
                entry.title = nextTitle;
                changed = true;
            }
            if (updatedAt && entry.updatedAt !== updatedAt) {
                entry.updatedAt = updatedAt;
            }
        };
        this.state.meetings.forEach(updateEntry);
        updateEntry(this.state.session?.meeting);
        if (changed) {
            this.renderMeetingList();
            this.renderMeetingSummary();
        }
        return changed;
    },

    async handleParticipantRosterEvent(event) {
        const parsed = parseWebMeetEvent(event?.data);
        const eventData = parsed.payload;
        const meetingId = String(eventData?.meetingId || parsed.room || this.state.selectedMeetingId || '').trim();
        const participantId = String(eventData?.participantId || '').trim();
        if (!meetingId) return;

        if (participantId && (parsed.type === WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT || parsed.type === WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT)) {
            this.removeParticipantFromMeetingList(meetingId, participantId);
            this.renderMeetingList();
        }

        try {
            await this.loadParticipantsForMeetings();
            if (meetingId && meetingId === String(this.state.selectedMeetingId || '').trim()) {
                await this.refreshMeetingDetailsFromRealtimeEvent();
            }
            this.renderMeetingList();
        } catch (_) {
            // Keep the immediate event update; the next event or explicit room load can resync.
        }
    }
};
