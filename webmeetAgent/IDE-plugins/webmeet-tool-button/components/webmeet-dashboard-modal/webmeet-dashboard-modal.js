import { MeetingPresenceController } from './controllers/meeting-presence-controller.js';
import { LivekitRoomController } from './controllers/livekit-room-controller.js';
import { MeetingListController } from './controllers/meeting-list-controller.js';
import { ParticipantLayoutController } from './controllers/participant-layout-controller.js';
import { WebmeetMediaController } from './controllers/webmeet-media-controller.js';
import { mediaSettingsMethods } from './controllers/media-settings-methods.js';
import { participantViewMethods } from './controllers/participant-view-methods.js';
import { roomSessionMethods } from './controllers/room-session-methods.js';
import { meetingActionMethods } from './controllers/meeting-action-methods.js';
import { dashboardRenderMethods } from './controllers/dashboard-render-methods.js';
import { dashboardChromeMethods } from './controllers/dashboard-chrome-methods.js';
import {
    ChatTranscriptComponent,
    GuestSessionManager
} from './service-components/index.js';
import { ensureLiveKitClient } from './services/livekit-loader.js';
import { buildRtcConfigForSession, installRtcPeerConnectionOverride } from './services/rtc-config.js';
import { runWebMeetTool } from './services/webmeet-api-client.js';
import {
    buildAuthenticatedWebMeetApiBaseUrl,
    buildPublicWebMeetApiBaseUrl,
    buildStableParticipantId,
    createParticipantInstanceId,
    isAdminActor,
    isMissingMeetingError,
    normalizeCurrentActor,
    readGuestSessionFromUrl
} from './services/dashboard-utils.js';

const runTool = runWebMeetTool;

export class WebMeetDashboardModal {
    constructor(element, invalidate, hostContext) {
        this.element = element;
        this.invalidate = invalidate;
        this.hostContext = hostContext || {};
        this.state = {
            workspaces: [],
            meetings: [],
            chat: [],
            transcript: [],
            artifacts: [],
            recordings: [],
            tasks: [],
            decisions: [],
            agents: [],
            meetingParticipantsById: {},
            selectedWorkspaceId: '',
            selectedMeetingId: '',
            joiningMeetingId: '',
            canManageRooms: false,
            session: null,
            roomState: 'Disconnected',
            transcriptState: 'Idle',
            media: {
                microphone: false,
                camera: false,
                screen: false
            },
            mediaLoading: {
                microphone: false,
                camera: false,
                screen: false
            },
            mediaSettings: {
                audioInputDeviceId: '',
                videoInputDeviceId: '',
                audioOutputDeviceId: '',
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                microphoneGain: 1,
                outputVolume: 1,
                cameraQuality: 'h720',
                screenShareQuality: 'h1080fps30'
            },
            mediaDeviceWarnings: [],
            mediaSettingsPanelVisible: false,
            participants: [],
            chatSidebarVisible: true,
            activeMobilePanel: 'room',
            videoGridFullscreen: false
        };
        this.room = null;
        this.meetingEventsSource = null;
        this.roomController = new LivekitRoomController({
            ensureLiveKitClient,
            buildRtcConfigForSession,
            installRtcPeerConnectionOverride,
            getAudioCaptureDefaults: () => this.mediaController.getMicrophoneEnableOptions(),
            getMediaQualitySettings: () => ({
                cameraQuality: this.normalizeCameraQuality(this.state.mediaSettings.cameraQuality),
                screenShareQuality: this.normalizeScreenShareQuality(this.state.mediaSettings.screenShareQuality)
            })
        });
        this.speechRecognition = null;
        this.meetingListController = new MeetingListController();
        this.participantLayoutController = new ParticipantLayoutController({
            getParticipantDisplayName: (participant) => this.getParticipantDisplayName(participant),
            getAgentForParticipant: (participant) => this.getAgentForParticipant(participant),
            canDetachAgent: () => this.canManageRooms() && !this.isGuestSession()
        });
        this.meetingDetailsLoadSeq = 0;
        this.cachedStableParticipantId = '';
        this.chatSidebarWidth = this.loadChatSidebarWidth();
        this.handleMediaDeviceChange = null;
        this.mediaDevices = {
            audioInput: [],
            videoInput: [],
            audioOutput: []
        };
        this.presenceController = new MeetingPresenceController({
            runTool: (name, args) => this.runPresenceTool(name, args),
            getContext: () => ({
                meetingId: this.state.session?.meeting?.id,
                participantId: this.state.session?.participantIdentity
            }),
            shouldPing: () => this.state.roomState === 'Connected',
            buildLeaveRequest: ({ meetingId, participantId }) => {
                const encodedMeetingId = encodeURIComponent(String(meetingId || '').trim());
                if (!encodedMeetingId) return null;
                if (this.isGuestSession()) {
                    const baseUrl = this.state.session?.publicApiBaseUrl || buildPublicWebMeetApiBaseUrl();
                    return {
                        url: `${baseUrl}/meetings/${encodedMeetingId}/guest-leave`,
                        body: {
                            guestToken: this.getGuestToken(),
                            participantId: String(participantId || '').trim()
                        }
                    };
                }
                const baseUrl = buildAuthenticatedWebMeetApiBaseUrl();
                return {
                    url: `${baseUrl}/meetings/${encodedMeetingId}/leave`,
                    body: {
                        participantId: String(participantId || '').trim()
                    }
                };
            }
        });
        this.mediaController = new WebmeetMediaController({
            getRoom: () => this.room,
            getTrack: () => window.LivekitClient?.Track || null,
            onMediaStateChange: (next, localParticipantId) => {
                this.state.media = next;
                if (localParticipantId) {
                    this.setParticipantMicState(localParticipantId, next.microphone);
                }
            },
            onError: (message) => {
                this.setError(message);
            },
            onAfterToggle: () => {
                this.renderMeetingSummary();
            }
        });
        this.state.mediaSettings = this.loadMediaSettings();
        this.mediaController.setSettings(this.state.mediaSettings);

        // Initialize new modular components
        this._initComponents();

        this.invalidate();
    }

    _initComponents() {
        // Chat and Transcript Component
        this.chatComponent = new ChatTranscriptComponent({
            isGuestSession: () => this.isGuestSession(),
            sendPublicChat: (meetingId, message) => this.sendPublicChat(meetingId, message),
            callPublicGuestApi: (meetingId, action, payload) => this.callPublicGuestApi(meetingId, action, payload),
            canManageArtifacts: () => this.canManageRooms(),
            getState: () => this.state,
            setState: (updates) => Object.assign(this.state, updates),
            setError: (msg) => this.setError(msg),
            getSelectedMeeting: () => this.selectedMeeting,
            getSession: () => this.state.session,
            renderFeedLists: () => this.renderFeedLists(),
            renderMeetingSummary: () => this.renderMeetingSummary(),
            renderAll: () => this.renderAll(),
            publishRealtimePayload: (payload) => this.publishRealtimePayload(payload),
            loadMeetingDetails: () => this.loadMeetingDetails(),
            getRoom: () => this.room
        });

        // Guest Session Manager
        this.guestManager = new GuestSessionManager({
            getState: () => this.state,
            setState: (updates) => Object.assign(this.state, updates),
            getSession: () => this.state.session,
            setSession: (session) => { this.state.session = session; },
            setError: (msg) => this.setError(msg),
            loadParticipantsForMeetings: () => this.loadParticipantsForMeetings(),
            loadMeetingDetails: () => this.loadMeetingDetails(),
            renderAll: () => this.renderAll(),
            connectRoom: () => this.connectRoom(),
            hostContext: this.hostContext
        });
    }

    beforeRender() {}

    async afterRender() {
        this.cacheElements();
        this.registerActions();
        this.registerChatSidebarResizer();
        this.registerWindowPresenceHandlers();
        this.registerMediaDeviceChangeHandler();
        this.registerMediaSettingsInputHandlers();
        this.renderMediaSettingsPanel();
        void this.refreshMediaDevices({ requestPermission: false, showToast: false });
        await this.bootstrap();
    }

    registerActions() {
        // Register actions with WebSkel if available
        if (this.hostContext && typeof this.hostContext.registerAction === 'function') {
            const actions = [
                'closeModal',
                'createMeeting',
                'renameMeeting',
                'deleteMeeting',
                'copyGuestInviteLink',
                'joinMeeting',
                'leaveMeeting',
                'toggleRecording',
                'toggleMicrophone',
                'toggleCamera',
                'toggleScreenShare',
                'toggleVideoGridFullscreen',
                'toggleFullscreen',
                'toggleChatSidebar',
                'toggleMediaSettings',
                'applyMediaSettings',
                'refreshMediaDevices',
                'focusParticipantCard',
                'sendChat',
                'appendTranscript',
                'startAutoTranscript',
                'stopAutoTranscript',
                'attachObserver',
                'attachAssistant',
                'attachScribe',
                'detachAgent',
                'detachAgentFromCard',
                'selectMeeting',
                'selectAndJoinMeeting',
                'openTranscript',
                'openArtifacts',
                'openRecordings',
                'openAI',
                'showRoomAiMenu'
            ];

            actions.forEach(action => {
                this.hostContext.registerAction(action, this[action].bind(this));
            });
        }

        // Add event listeners for mobile panels and collapse controls that are not WebSkel actions.
        this.element.addEventListener('click', this.handleClick);
    }

    handleClick = (event) => {
        const mobilePanelButton = event.target?.closest?.('[data-mobile-panel]');
        if (mobilePanelButton) {
            this.setMobilePanel(String(mobilePanelButton.dataset.mobilePanel || 'room').trim());
            return;
        }

        // Handle collapse/expand buttons
        const collapseButton = event.target?.closest?.('[data-collapse]');
        if (collapseButton) {
            const collapsibleId = String(collapseButton.dataset.collapse || '').trim();

            // Toggle button state
            collapseButton.classList.toggle('collapsed');

            // Handle transcript collapse (vertical content)
            const collapsibles = this.element.querySelectorAll(`[data-collapsible="${collapsibleId}"]`);
            const isCollapsed = collapseButton.classList.contains('collapsed');

            // Toggle collapsible elements
            collapsibles.forEach(el => {
                el.classList.toggle('expanded', !isCollapsed);
            });

            return;
        }
    };

    cacheElements() {
        this.workspaceList = this.element.querySelector('#webmeetWorkspaceList');
        this.currentWorkspace = this.element.querySelector('#webmeetCurrentWorkspace');
        this.toastContainer = this.element.querySelector('#webmeetToastContainer');
        this.meetingList = this.element.querySelector('#webmeetMeetingList');
        this.meetingTitle = this.element.querySelector('#webmeetMeetingTitle');
        this.meetingMeta = this.element.querySelector('#webmeetMeetingMeta');
        this.joinStatus = this.element.querySelector('#webmeetJoinStatus');
        this.activeRoomTitle = this.element.querySelector('#webmeetActiveRoomTitle');
        this.lifecycle = this.element.querySelector('#webmeetLifecycle');
        this.joinPayload = this.element.querySelector('#webmeetJoinPayload');
        this.chatList = this.element.querySelector('#webmeetChatList');
        this.chatInput = this.element.querySelector('#webmeetChatInput');
        this.taskList = this.element.querySelector('#webmeetTaskList');
        this.decisionList = this.element.querySelector('#webmeetDecisionList');
        this.roomConnectionState = this.element.querySelector('#webmeetRoomConnectionState');
        this.videoGrid = this.element.querySelector('#webmeetVideoGrid');
        this.videoGridEmpty = this.element.querySelector('#webmeetVideoEmpty');
        this.videoGridAll = this.element.querySelector('#webmeetVideoAll');
        this.recordingButton = this.element.querySelector('#webmeetRecordingButton');
        this.micButton = this.element.querySelector('#webmeetMicButton');
        this.cameraButton = this.element.querySelector('#webmeetCameraButton');
        this.screenShareButton = this.element.querySelector('#webmeetScreenShareButton');
        this.videoGridFullscreenButton = this.element.querySelector('#webmeetVideoGridFullscreenButton');
        this.dashboardModalRoot = this.element.querySelector('.webmeet-dashboard-modal');
        this.chatSidebar = this.element.querySelector('#webmeetChatSidebar');
        this.chatResizer = this.element.querySelector('#webmeetChatResizer');
        this.toggleChatButton = this.element.querySelector('#webmeetToggleChatButton');
        this.createRoomButton = this.element.querySelector('#webmeetCreateRoomButton');
        this.fullscreenButton = this.element.querySelector('#webmeetModalFullscreen');
        this.mediaSettingsButton = this.element.querySelector('#webmeetMediaSettingsButton');
        this.mediaSettingsPanel = this.element.querySelector('#webmeetMediaSettingsPanel');
        this.audioInputSelect = this.element.querySelector('#webmeetAudioInputSelect');
        this.videoInputSelect = this.element.querySelector('#webmeetVideoInputSelect');
        this.cameraQualitySelect = this.element.querySelector('#webmeetCameraQualitySelect');
        this.screenShareQualitySelect = this.element.querySelector('#webmeetScreenShareQualitySelect');
        this.audioOutputSelect = this.element.querySelector('#webmeetAudioOutputSelect');
        this.echoCancellationInput = this.element.querySelector('#webmeetAudioEchoCancellation');
        this.noiseSuppressionInput = this.element.querySelector('#webmeetAudioNoiseSuppression');
        this.autoGainControlInput = this.element.querySelector('#webmeetAudioAutoGainControl');
        this.microphoneGainInput = this.element.querySelector('#webmeetMicrophoneGain');
        this.microphoneGainValue = this.element.querySelector('#webmeetMicrophoneGainValue');
        this.microphoneGainWarning = this.element.querySelector('#webmeetMicrophoneGainWarning');
        this.outputVolumeInput = this.element.querySelector('#webmeetOutputVolume');
        this.outputVolumeValue = this.element.querySelector('#webmeetOutputVolumeValue');
        this.mediaDeviceWarnings = this.element.querySelector('#webmeetMediaDeviceWarnings');
        this.welcomeScreen = this.element.querySelector('#webmeetWelcomeScreen');
        this.meetingBar = this.element.querySelector('.webmeet-meeting-bar');
        this.mainContent = this.element.querySelector('.webmeet-main-content');
        this.mobileNav = this.element.querySelector('.webmeet-mobile-nav');
        this.mobileNavButtons = Array.from(this.element.querySelectorAll('[data-mobile-panel]'));
        this.meetingListController.setElement(this.meetingList);
        this.participantLayoutController.setElements({
            videoGrid: this.videoGrid,
            videoGridAll: this.videoGridAll,
            videoGridEmpty: this.videoGridEmpty
        });

        // Set elements on new modular components
        this.chatComponent?.setElements({
            chatInput: this.chatInput
        });

        this.applyChatSidebarWidth();
        this.applyMobilePanelState();
    }






























    afterUnload() {
        this.element.removeEventListener('click', this.handleClick);
        this.stopMeetingEvents();
        this.unregisterMediaDeviceChangeHandler();
        this.presenceController.teardown();
        if (this.state.session?.participantIdentity) {
            void this.unjoinCurrentSession({ preserveDisplayName: false });
            return;
        }
        void this.disconnectRoom();
    }

    async bootstrap() {
        try {
            this.syncFullscreenButtonState();
            const guestSession = readGuestSessionFromUrl();
            if (guestSession?.meeting?.id && guestSession?.participantToken) {
                await this.bootstrapGuestSession(guestSession);
                return;
            }
            await this.loadWorkspaces();
            this.state.selectedWorkspaceId = this.state.workspaces[0]?.id || '';
            if (this.state.selectedWorkspaceId) {
                await this.loadMeetings();
            }
            this.renderAll();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        }
    }

    async bootstrapGuestSession(session) {
        // Delegate to GuestSessionManager
        await this.guestManager.bootstrapGuestSession(session);
    }

    get selectedMeeting() {
        return this.state.meetings.find((entry) => entry.id === this.state.selectedMeetingId) || null;
    }

    get currentActor() {
        return normalizeCurrentActor();
    }

    canManageRooms() {
        // Use canManageRooms from meeting_list response (based on actual authInfo from router)
        // Falls back to client-side check if state not loaded yet
        if (typeof this.state.canManageRooms === 'boolean') {
            return this.state.canManageRooms;
        }
        return isAdminActor(this.currentActor);
    }

    isGuestSession() {
        // Delegate to GuestSessionManager
        return this.guestManager.isGuestSession();
    }

    getGuestToken() {
        return String(this.state.session?.guestToken || '').trim();
    }

    async callPublicGuestApi(meetingId, action, body = {}) {
        // Delegate to GuestSessionManager
        return this.guestManager.callPublicGuestApi(meetingId, action, body);
    }

    async runPresenceTool(name, args = {}) {
        if (!this.isGuestSession()) {
            return runTool(name, args);
        }
        const meetingId = String(args.meetingId || '').trim();
        if (!meetingId || name !== 'webmeet_meeting_presence_ping') return {};
        return this.callPublicGuestApi(meetingId, 'guest-presence', {});
    }

    async loadWorkspaces() {
        const payload = await runTool('webmeet_workspace_list');
        this.state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    }

    async loadMeetings() {
        const loadSeq = this.meetingDetailsLoadSeq + 1;
        this.meetingDetailsLoadSeq = loadSeq;
        if (!this.state.selectedWorkspaceId) {
            this.state.meetings = [];
            this.state.meetingParticipantsById = {};
            this.state.selectedMeetingId = '';
            return;
        }
        const payload = await runTool('webmeet_meeting_list', {
            workspaceId: this.state.selectedWorkspaceId
        });
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.canManageRooms = payload.canManageRooms === true;
        await this.loadParticipantsForMeetings();
        if (loadSeq !== this.meetingDetailsLoadSeq) return;
        this.state.selectedMeetingId = this.state.meetings.some((entry) => entry.id === this.state.selectedMeetingId)
            ? this.state.selectedMeetingId
            : '';
        if (this.state.selectedMeetingId) {
            await this.loadMeetingDetails({ expectedMeetingId: this.state.selectedMeetingId });
        }
    }

    async refreshMeetingsAfterMissingMeeting(missingMeetingId) {
        const payload = await runTool('webmeet_meeting_list', {
            workspaceId: this.state.selectedWorkspaceId
        });
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.canManageRooms = payload.canManageRooms === true;
        await this.loadParticipantsForMeetings();
        return this.state.meetings.some((entry) => entry.id === missingMeetingId);
    }

    async fetchPublicMeetingDetails(meetingId) {
        // Delegate to GuestSessionManager
        return this.guestManager.fetchPublicMeetingDetails(meetingId);
    }

    async loadParticipantsForMeetings() {
        const meetings = Array.isArray(this.state.meetings) ? this.state.meetings : [];
        const mapMeetingRoster = (details) => {
            const participants = Array.isArray(details?.participants) ? details.participants : [];
            const agents = Array.isArray(details?.agents)
                ? details.agents.filter((entry) => entry && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped')
                : [];
            const roster = participants.map((entry) => ({
                id: String(entry?.id || '').trim(),
                name: String(entry?.displayName || entry?.id || 'Participant').trim() || 'Participant',
                micOn: typeof entry?.micOn === 'boolean' ? entry.micOn : false,
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
                    micOn: false,
                    isAgent: true
                });
            }
            return roster;
        };
        if (this.isGuestSession()) {
            // For guest, load participants from the single meeting via public API
            const meeting = meetings[0];
            if (meeting?.id) {
                try {
                    const details = await this.fetchPublicMeetingDetails(meeting.id);
                    this.state.meetingParticipantsById = {
                        [meeting.id]: mapMeetingRoster(details)
                    };
                } catch (error) {
                    this.state.meetingParticipantsById = {};
                }
            } else {
                this.state.meetingParticipantsById = {};
            }
            return;
        }
        const results = await Promise.allSettled(
            meetings.map((meeting) => runTool('webmeet_meeting_get', { meetingId: meeting.id }))
        );
        const nextMap = {};
        for (let index = 0; index < meetings.length; index += 1) {
            const meeting = meetings[index];
            const result = results[index];
            if (result.status !== 'fulfilled') {
                nextMap[meeting.id] = [];
                continue;
            }
            nextMap[meeting.id] = mapMeetingRoster(result.value);
        }
        this.state.meetingParticipantsById = nextMap;
    }

    async loadMeetingDetails(options = {}) {
        const expectedMeetingId = String(options.expectedMeetingId || this.state.selectedMeetingId || '').trim();
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
            this.state.transcript = [];
            this.state.artifacts = [];
            this.state.recordings = [];
            this.state.tasks = [];
            this.state.decisions = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            return;
        }
        if (this.isGuestSession()) {
            try {
                const details = await this.fetchPublicMeetingDetails(meeting.id);
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                this.state.participants = Array.isArray(details?.participants) ? details.participants : [];
                this.state.chat = Array.isArray(details?.chat) ? details.chat : [];
                this.state.transcript = Array.isArray(details?.transcript) ? details.transcript : [];
                this.state.artifacts = Array.isArray(details?.artifacts) ? details.artifacts : [];
                this.state.recordings = Array.isArray(details?.recordings) ? details.recordings : [];
                this.state.tasks = Array.isArray(details?.tasks) ? details.tasks : [];
                this.state.decisions = Array.isArray(details?.decisions) ? details.decisions : [];
                this.state.agents = Array.isArray(details?.agents) ? details.agents : [];
            } catch (error) {
                if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
                this.state.participants = [];
                this.state.chat = [];
                this.state.transcript = [];
                this.state.artifacts = [];
                this.state.recordings = [];
                this.state.tasks = [];
                this.state.decisions = [];
                this.state.agents = [];
            }
            return;
        }
        let chatPayload;
        let transcriptPayload = { transcript: [] };
        let artifactPayload = { artifacts: [], recordings: [], tasks: [], decisions: [] };
        let agentPayload = { agents: [] };
        try {
            const canManageMeetingData = this.canManageRooms();
            if (canManageMeetingData) {
                [chatPayload, transcriptPayload, artifactPayload, agentPayload] = await Promise.all([
                    runTool('webmeet_chat_list', { meetingId: meeting.id }),
                    runTool('webmeet_transcript_list', { meetingId: meeting.id }),
                    runTool('webmeet_artifact_list', { meetingId: meeting.id }),
                    runTool('webmeet_agent_list', { meetingId: meeting.id })
                ]);
            } else {
                chatPayload = await runTool('webmeet_chat_list', { meetingId: meeting.id });
            }
        } catch (error) {
            if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
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
            this.state.transcript = [];
            this.state.artifacts = [];
            this.state.recordings = [];
            this.state.tasks = [];
            this.state.decisions = [];
            this.state.agents = [];
            this.state.session = null;
            this.state.participants = [];
            this.setError('Room is no longer available. Refreshing rooms.');
            return;
        }
        if (loadSeq !== this.meetingDetailsLoadSeq || this.state.selectedMeetingId !== meeting.id) return;
        this.state.chat = Array.isArray(chatPayload.messages) ? chatPayload.messages : [];
        this.state.transcript = Array.isArray(transcriptPayload.transcript) ? transcriptPayload.transcript : [];
        this.state.artifacts = Array.isArray(artifactPayload.artifacts) ? artifactPayload.artifacts : [];
        this.state.recordings = Array.isArray(artifactPayload.recordings) ? artifactPayload.recordings : [];
        this.state.tasks = Array.isArray(artifactPayload.tasks) ? artifactPayload.tasks : [];
        this.state.decisions = Array.isArray(artifactPayload.decisions) ? artifactPayload.decisions : [];
        this.state.agents = Array.isArray(agentPayload.agents) ? agentPayload.agents : [];
    }

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
    }

    async handleParticipantRosterEvent(event) {
        let eventData = {};
        try {
            eventData = JSON.parse(String(event?.data || '{}'));
        } catch (_) {
            return;
        }
        const payload = eventData?.payload || eventData;
        const meetingId = String(payload?.meetingId || eventData?.meetingId || this.state.selectedMeetingId || '').trim();
        const participantId = String(payload?.participantId || eventData?.participantId || '').trim();
        if (!meetingId) return;

        if (participantId && (eventData.type === 'participant.left' || eventData.type === 'participant.timed_out')) {
            this.removeParticipantFromMeetingList(meetingId, participantId);
            this.renderMeetingList();
        }

        try {
            await this.loadParticipantsForMeetings();
            this.renderMeetingList();
        } catch (_) {
            // Keep the immediate event update; the next event or explicit room load can resync.
        }
    }

    async publishRealtimePayload(payload) {
        if (!this.room?.localParticipant || !payload || typeof payload !== 'object') return;
        const encoder = new TextEncoder();
        let kindValue = 0;
        if (window.LivekitClient?.DataPacket_Kind?.RELIABLE !== undefined) {
            kindValue = window.LivekitClient.DataPacket_Kind.RELIABLE;
        }
        await this.room.localParticipant.publishData(encoder.encode(JSON.stringify(payload)), kindValue);
    }

    startMeetingEvents() {
        this.stopMeetingEvents();
        const meetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        if (!meetingId || !this.state.session?.participantIdentity || typeof EventSource !== 'function') return;
        const baseUrl = this.isGuestSession()
            ? (this.state.session?.publicApiBaseUrl || buildPublicWebMeetApiBaseUrl())
            : buildAuthenticatedWebMeetApiBaseUrl();
        const url = new URL(`${baseUrl}/meetings/${encodeURIComponent(meetingId)}/events`);
        if (this.isGuestSession()) {
            url.searchParams.set('guestToken', this.getGuestToken());
            url.searchParams.set('participantId', String(this.state.session?.participantIdentity || '').trim());
        }
        this.meetingEventsSource = new EventSource(url.toString(), { withCredentials: true });
        this.meetingEventsSource.addEventListener('meeting.renamed', (event) => {
            try {
                const payload = JSON.parse(String(event.data || '{}'));
                this.applyMeetingRename(
                    payload?.payload?.meetingId || payload?.meetingId,
                    payload?.payload?.title || payload?.title,
                    payload?.createdAt || ''
                );
            } catch (_) {
                // Ignore malformed event payloads.
            }
        });
        for (const eventName of ['participant.joined', 'participant.left', 'participant.timed_out']) {
            this.meetingEventsSource.addEventListener(eventName, (event) => {
                void this.handleParticipantRosterEvent(event);
            });
        }
        for (const eventName of ['agent.dispatched', 'agent.detached', 'transcript.updated']) {
            this.meetingEventsSource.addEventListener(eventName, () => {
                void (async () => {
                    await this.loadMeetingDetails();
                    if (this.room && window.LivekitClient?.Track) {
                        this.syncParticipantsFromRoom(this.room, window.LivekitClient.Track);
                    }
                    this.renderAll();
                })();
            });
        }
        // Handle 404 or other errors gracefully - don't spam console
        this.meetingEventsSource.onerror = (error) => {
            // Silently ignore - events endpoint is optional
            this.stopMeetingEvents();
        };
    }

    stopMeetingEvents() {
        if (!this.meetingEventsSource) return;
        try { this.meetingEventsSource.close(); } catch (_) {}
        this.meetingEventsSource = null;
    }





    registerWindowPresenceHandlers() {
        this.presenceController.registerWindowHandlers();
    }

    unregisterWindowPresenceHandlers() {
        this.presenceController.unregisterWindowHandlers();
    }

    async sendPresencePing() {
        await this.presenceController.sendPresencePing();
    }

    startPresenceHeartbeat() {
        this.presenceController.startHeartbeat();
    }

    stopPresenceHeartbeat() {
        this.presenceController.stopHeartbeat();
    }

    sendLeaveKeepalive(meetingId, participantId) {
        this.presenceController.sendLeaveKeepalive(meetingId, participantId);
    }

    getStableParticipantId(displayName = '') {
        if (this.cachedStableParticipantId) {
            return this.cachedStableParticipantId;
        }
        const userEmail = String(window?.assistOS?.user?.email || '').trim();
        const baseSeed = userEmail || (String(displayName || 'user').trim() || 'user');
        const sessionKey = 'webmeet.participant.instanceId';
        try {
            let instanceId = String(window?.sessionStorage?.getItem(sessionKey) || '').trim();
            if (!instanceId) {
                instanceId = createParticipantInstanceId();
                window?.sessionStorage?.setItem(sessionKey, instanceId);
            }
            const created = buildStableParticipantId(`${baseSeed}-${instanceId}`);
            this.cachedStableParticipantId = created;
            return created;
        } catch {
            this.cachedStableParticipantId = buildStableParticipantId(`${baseSeed}-${createParticipantInstanceId()}`);
            return this.cachedStableParticipantId;
        }
    }

    removeParticipantFromMeetingList(meetingId, participantId) {
        this.meetingListController.removeParticipantFromMeetingMap(
            this.state.meetingParticipantsById,
            meetingId,
            participantId
        );
    }



    async selectMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        this.state.selectedMeetingId = nextMeetingId;
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
        } finally {
            this.renderAll();
        }
    }

    async selectAndJoinMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        if (!nextMeetingId) return;
        if (this.state.joiningMeetingId) return;
        const currentMeetingId = String(this.state.session?.meeting?.id || '').trim();
        const currentlyJoined = Boolean(this.state.session?.participantIdentity);
        const switchingRoom = Boolean(currentlyJoined && currentMeetingId && currentMeetingId !== nextMeetingId);
        if (currentlyJoined && currentMeetingId === nextMeetingId) {
            this.state.selectedMeetingId = nextMeetingId;
            try {
                await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            } finally {
                this.renderAll();
            }
            return;
        }

        if (switchingRoom) {
            const currentMeeting = this.state.meetings.find((entry) => entry.id === currentMeetingId);
            const nextMeeting = this.state.meetings.find((entry) => entry.id === nextMeetingId);
            const confirmed = window.confirm(
                `Leave "${currentMeeting?.title || 'current room'}" and join "${nextMeeting?.title || 'selected room'}"?`
            );
            if (!confirmed) {
                return;
            }
            await this.unjoinCurrentSession({ preserveDisplayName: true });
        }

        this.state.selectedMeetingId = nextMeetingId;
        this.state.joiningMeetingId = nextMeetingId;
        this.renderMeetingList();
        try {
            await this.loadMeetingDetails({ expectedMeetingId: nextMeetingId });
            this.renderAll();
            if (!this.selectedMeeting) {
                return;
            }
            const defaultName = String(this.state.session?.participant?.displayName || '').trim();
            await this.joinMeeting({ displayNameOverride: defaultName });
            this.setMobilePanel('room');
        } catch (error) {
            const message = String(error?.message || error || '').trim();
            if (message.includes('Unsupported state or unable to authenticate data')) {
                this.setError('Room data cannot be decrypted with the current WebMeet key. Restore the previous Ploinky master key or recreate the room.');
            } else {
                this.setError(message || 'Failed to join room.');
            }
        } finally {
            if (this.state.joiningMeetingId === nextMeetingId) {
                this.state.joiningMeetingId = '';
                this.renderMeetingList();
            }
        }
    }











    async sendChat() {
        // Delegate to ChatTranscriptComponent
        return this.chatComponent.sendChat();
    }

    async appendTranscript() {
        // Delegate to ChatTranscriptComponent
        return this.chatComponent.appendTranscript();
    }

    startSpeechRecognition() {
        // Delegate to ChatTranscriptComponent - store reference for compatibility
        this.chatComponent.startSpeechRecognition();
        this.speechRecognition = this.chatComponent.speechRecognition;
    }

    stopSpeechRecognition() {
        // Delegate to ChatTranscriptComponent
        this.chatComponent.stopSpeechRecognition();
        this.speechRecognition = null;
    }

    async startAutoTranscript() {
        this.startSpeechRecognition();
    }

    async stopAutoTranscript() {
        this.stopSpeechRecognition();
    }









    async closeModal(target) {
        if (this.state.session?.participantIdentity) {
            await this.unjoinCurrentSession({ preserveDisplayName: false });
        }
        const dialog = this.getDialogElement();
        if (dialog) {
            dialog.classList.remove('is-fullscreen');
        }
        assistOS.UI.closeModal(target || this.element);
    }
}

Object.assign(WebMeetDashboardModal.prototype, dashboardChromeMethods, participantViewMethods, roomSessionMethods, meetingActionMethods, dashboardRenderMethods, mediaSettingsMethods);
