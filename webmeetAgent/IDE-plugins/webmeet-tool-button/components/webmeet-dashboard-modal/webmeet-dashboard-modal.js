import { MeetingPresenceController } from './controllers/meeting-presence-controller.js';
import { LivekitRoomController } from './controllers/livekit-room-controller.js';
import { MeetingListController } from './controllers/meeting-list-controller.js';
import { ParticipantLayoutController } from './controllers/participant-layout-controller.js';
import { WebmeetMediaController } from './controllers/webmeet-media-controller.js';
import { ensureLiveKitClient } from './services/livekit-loader.js';
import { buildRtcConfigForSession, installRtcPeerConnectionOverride } from './services/rtc-config.js';
import { runWebMeetTool, WEBMEET_AGENT_NAME } from './services/webmeet-api-client.js';

const AGENT_NAME = WEBMEET_AGENT_NAME;
const runTool = runWebMeetTool;

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function formatDate(value) {
    if (!value) return '';
    try {
        return new Date(value).toLocaleString();
    } catch {
        return String(value);
    }
}

function buildStableParticipantId(seed) {
    const base = String(seed || '').trim().toLowerCase();
    const safe = base.replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!safe) {
        return `participant-${Math.random().toString(36).slice(2, 10)}`;
    }
    return `participant-${safe}`;
}

function createParticipantInstanceId() {
    try {
        if (typeof crypto?.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (_) {
        // ignore and fallback
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeCurrentActor() {
    const user = globalThis.assistOS?.user;
    if (!user || typeof user !== 'object') {
        return {
            id: '',
            username: '',
            email: '',
            principalId: '',
            roles: []
        };
    }
    return {
        id: String(user.id || '').trim(),
        username: String(user.username || user.name || '').trim(),
        email: String(user.email || '').trim(),
        principalId: String(user.principalId || '').trim(),
        roles: Array.isArray(user.roles) ? user.roles.map((role) => String(role || '').trim()).filter(Boolean) : []
    };
}

function getCurrentActorDisplayName() {
    const user = globalThis.assistOS?.user;
    if (!user || typeof user !== 'object') return '';
    const explicitName = String(user.name || user.username || '').trim();
    if (explicitName) return explicitName;
    const email = String(user.email || '').trim();
    return email && email !== 'local@example.com' ? email : '';
}

function isAdminActor(actor = null) {
    if (!actor || typeof actor !== 'object') return false;
    const roles = Array.isArray(actor.roles) ? actor.roles : [];
    if (roles.some((role) => String(role || '').trim().toLowerCase() === 'admin')) {
        return true;
    }
    return String(actor.username || '').trim().toLowerCase() === 'admin'
        || String(actor.id || '').trim() === 'local:admin'
        || String(actor.principalId || '').trim() === 'user:local:admin';
}

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
            session: null,
            roomState: 'Disconnected',
            transcriptState: 'Idle',
            media: {
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
                autoGainControl: true
            },
            mediaSettingsPanelVisible: false,
            participants: [],
            chatSidebarVisible: true,
            videoGridFullscreen: false
        };
        this.room = null;
        this.roomController = new LivekitRoomController({
            ensureLiveKitClient,
            buildRtcConfigForSession,
            installRtcPeerConnectionOverride,
            getAudioCaptureDefaults: () => this.mediaController.getMicrophoneEnableOptions()
        });
        this.speechRecognition = null;
        this.meetingListController = new MeetingListController();
        this.participantLayoutController = new ParticipantLayoutController({
            getParticipantDisplayName: (participant) => this.getParticipantDisplayName(participant)
        });
        this.pollingInterval = null;
        this.cachedStableParticipantId = '';
        this.chatSidebarWidth = this.loadChatSidebarWidth();
        this.mediaDevices = {
            audioInput: [],
            videoInput: [],
            audioOutput: []
        };
        this.presenceController = new MeetingPresenceController({
            runTool,
            agentName: AGENT_NAME,
            getContext: () => ({
                meetingId: this.state.session?.meeting?.id,
                participantId: this.state.session?.participantIdentity
            }),
            shouldPing: () => this.state.roomState === 'Connected'
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
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.cacheElements();
        this.registerActions();
        this.registerChatSidebarResizer();
        this.registerWindowPresenceHandlers();
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
                'selectMeeting',
                'selectAndJoinMeeting'
            ];

            actions.forEach(action => {
                this.hostContext.registerAction(action, this[action].bind(this));
            });
        }

        // Add event listeners for tabs and collapse (not WebSkel actions)
        this.element.addEventListener('click', this.handleClick);
    }

    handleClick = (event) => {
        // Handle tab switching
        const tabButton = event.target?.closest?.('[data-tab]');
        if (tabButton) {
            const tabId = String(tabButton.dataset.tab || '').trim();
            const tabGroup = tabButton.closest('.webmeet-tabs');

            // Update active state for tab buttons in this group
            tabGroup.querySelectorAll('.webmeet-tab').forEach(btn => {
                btn.classList.toggle('webmeet-tab-active', btn.dataset.tab === tabId);
            });

            // Handle secondary tabs (transcript, artifacts, recordings)
            const secondaryTabs = ['transcript', 'artifacts', 'recordings'];
            if (secondaryTabs.includes(tabId)) {
                secondaryTabs.forEach(t => {
                    const tabContent = this.element.querySelector(`#webmeet${t.charAt(0).toUpperCase() + t.slice(1)}Tab`);
                    if (tabContent) {
                        if (t === tabId) {
                            tabContent.classList.remove('webmeet-hidden');
                        } else {
                            tabContent.classList.add('webmeet-hidden');
                        }
                    }
                });
            }

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
        this.lifecycle = this.element.querySelector('#webmeetLifecycle');
        this.joinPayload = this.element.querySelector('#webmeetJoinPayload');
        this.chatList = this.element.querySelector('#webmeetChatList');
        this.chatInput = this.element.querySelector('#webmeetChatInput');
        this.transcriptList = this.element.querySelector('#webmeetTranscriptList');
        this.transcriptSpeaker = this.element.querySelector('#webmeetTranscriptSpeaker');
        this.transcriptInput = this.element.querySelector('#webmeetTranscriptInput');
        this.artifactList = this.element.querySelector('#webmeetArtifactList');
        this.recordingList = this.element.querySelector('#webmeetRecordingList');
        this.taskList = this.element.querySelector('#webmeetTaskList');
        this.decisionList = this.element.querySelector('#webmeetDecisionList');
        this.agentList = this.element.querySelector('#webmeetAgentList');
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
        this.renameRoomButton = this.element.querySelector('#webmeetRenameRoomButton');
        this.closeRoomButton = this.element.querySelector('#webmeetCloseRoomButton');
        this.fullscreenButton = this.element.querySelector('#webmeetModalFullscreen');
        this.mediaSettingsButton = this.element.querySelector('#webmeetMediaSettingsButton');
        this.mediaSettingsPanel = this.element.querySelector('#webmeetMediaSettingsPanel');
        this.audioInputSelect = this.element.querySelector('#webmeetAudioInputSelect');
        this.videoInputSelect = this.element.querySelector('#webmeetVideoInputSelect');
        this.audioOutputSelect = this.element.querySelector('#webmeetAudioOutputSelect');
        this.echoCancellationInput = this.element.querySelector('#webmeetAudioEchoCancellation');
        this.noiseSuppressionInput = this.element.querySelector('#webmeetAudioNoiseSuppression');
        this.autoGainControlInput = this.element.querySelector('#webmeetAudioAutoGainControl');
        this.welcomeScreen = this.element.querySelector('#webmeetWelcomeScreen');
        this.meetingBar = this.element.querySelector('.webmeet-meeting-bar');
        this.mainContent = this.element.querySelector('.webmeet-main-content');
        this.secondaryPanels = this.element.querySelector('.webmeet-secondary-panels');
        this.meetingListController.setElement(this.meetingList);
        this.participantLayoutController.setElements({
            videoGrid: this.videoGrid,
            videoGridAll: this.videoGridAll,
            videoGridEmpty: this.videoGridEmpty
        });
        this.applyChatSidebarWidth();
    }

    getDialogElement() {
        return this.element?.closest?.('dialog') || null;
    }

    syncFullscreenButtonState() {
        const dialog = this.getDialogElement();
        const isFullscreen = Boolean(dialog?.classList.contains('is-fullscreen'));
        if (!this.fullscreenButton) return;
        this.fullscreenButton.classList.toggle('active', isFullscreen);
        this.fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen';
        this.fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen');
    }

    toggleFullscreen() {
        const dialog = this.getDialogElement();
        if (!dialog) return;
        dialog.classList.toggle('is-fullscreen');
        this.syncFullscreenButtonState();
    }

    applyChatSidebarVisibility() {
        const isVisible = this.state.chatSidebarVisible !== false;
        if (this.chatSidebar) {
            this.chatSidebar.classList.toggle('webmeet-hidden', !isVisible);
        }
        if (this.chatResizer) {
            this.chatResizer.classList.toggle('webmeet-hidden', !isVisible);
        }
        if (this.mainContent) {
            this.mainContent.classList.toggle('webmeet-chat-hidden', !isVisible);
        }
        if (this.toggleChatButton) {
            this.toggleChatButton.classList.toggle('active', isVisible);
            this.toggleChatButton.title = isVisible ? 'Hide chat' : 'Show chat';
            this.toggleChatButton.setAttribute('aria-label', isVisible ? 'Hide chat' : 'Show chat');
        }
    }

    toggleChatSidebar() {
        this.state.chatSidebarVisible = !this.state.chatSidebarVisible;
        this.applyChatSidebarVisibility();
    }

    loadChatSidebarWidth() {
        const fallback = 320;
        try {
            const raw = Number.parseInt(String(window?.localStorage?.getItem('webmeet.chatSidebarWidth') || '').trim(), 10);
            if (!Number.isFinite(raw)) return fallback;
            return Math.max(260, Math.min(1400, raw));
        } catch {
            return fallback;
        }
    }

    persistChatSidebarWidth() {
        try {
            window?.localStorage?.setItem('webmeet.chatSidebarWidth', String(this.chatSidebarWidth));
        } catch (_) {
            // ignore storage failures
        }
    }

    applyChatSidebarWidth() {
        if (!this.mainContent) return;
        this.mainContent.style.setProperty('--webmeet-chat-sidebar-width', `${this.chatSidebarWidth}px`);
    }

    registerChatSidebarResizer() {
        if (!this.chatResizer || !this.mainContent || this.chatResizer.dataset.bound === 'true') {
            return;
        }
        const startResize = (event) => {
            if (this.state.chatSidebarVisible === false) return;
            event.preventDefault();
            event.stopPropagation();

            const mainRect = this.mainContent.getBoundingClientRect();
            const minWidth = 260;
            const minLiveWidth = 252;
            const resizerWidth = 10;
            const maxWidth = Math.max(minWidth, Math.floor(mainRect.width - minLiveWidth - resizerWidth));

            const onMove = (moveEvent) => {
                const nextWidth = Math.round(mainRect.right - moveEvent.clientX);
                this.chatSidebarWidth = Math.max(minWidth, Math.min(maxWidth, nextWidth));
                this.mainContent.classList.add('webmeet-chat-resizing');
                this.applyChatSidebarWidth();
            };

            const onUp = () => {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                this.mainContent.classList.remove('webmeet-chat-resizing');
                this.persistChatSidebarWidth();
            };

            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
        };

        this.chatResizer.addEventListener('pointerdown', startResize);
        this.chatResizer.dataset.bound = 'true';
    }

    applyVideoGridFullscreenMode() {
        const isActive = Boolean(this.state.videoGridFullscreen);
        if (this.dashboardModalRoot) {
            this.dashboardModalRoot.classList.toggle('webmeet-video-grid-fullscreen-mode', isActive);
        }
        if (this.videoGridFullscreenButton) {
            this.videoGridFullscreenButton.classList.toggle('active', isActive);
            const label = isActive ? 'Exit video fullscreen' : 'Video fullscreen';
            this.videoGridFullscreenButton.title = label;
            this.videoGridFullscreenButton.setAttribute('aria-label', label);
        }
    }

    loadMediaSettings() {
        const fallback = {
            audioInputDeviceId: '',
            videoInputDeviceId: '',
            audioOutputDeviceId: '',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        };
        try {
            const raw = String(window?.localStorage?.getItem('webmeet.mediaSettings') || '').trim();
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                ...fallback,
                ...parsed
            };
        } catch {
            return fallback;
        }
    }

    persistMediaSettings() {
        try {
            window?.localStorage?.setItem('webmeet.mediaSettings', JSON.stringify(this.state.mediaSettings));
        } catch (_) {
            // ignore storage failures
        }
    }

    async refreshMediaDevices(options = {}) {
        const requestPermission = options.requestPermission === undefined ? true : Boolean(options.requestPermission);
        const requestAudioPermission = options.requestAudioPermission === undefined ? requestPermission : Boolean(options.requestAudioPermission);
        const requestVideoPermission = options.requestVideoPermission === undefined ? false : Boolean(options.requestVideoPermission);
        const showToast = options.showToast === undefined ? true : Boolean(options.showToast);
        if (!navigator?.mediaDevices?.enumerateDevices) {
            this.setError('Media device enumeration is not supported in this browser.');
            return;
        }
        try {
            if ((requestAudioPermission || requestVideoPermission) && navigator?.mediaDevices?.getUserMedia) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: requestAudioPermission,
                        video: requestVideoPermission
                    });
                    for (const track of stream.getTracks()) {
                        try { track.stop(); } catch (_) {}
                    }
                } catch (_) {
                    // ignore permission refusal and still enumerate what is available
                }
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.mediaDevices = {
                audioInput: devices.filter((d) => d.kind === 'audioinput'),
                videoInput: devices.filter((d) => d.kind === 'videoinput'),
                audioOutput: devices.filter((d) => d.kind === 'audiooutput')
            };
        } catch (_) {
            this.mediaDevices = { audioInput: [], videoInput: [], audioOutput: [] };
            this.setError('Failed to refresh media devices.');
            return;
        }
        this.renderMediaSettingsPanel();
        if (showToast) {
            const ai = this.mediaDevices.audioInput.length;
            const vi = this.mediaDevices.videoInput.length;
            const ao = this.mediaDevices.audioOutput.length;
            this.setError(`Devices refreshed: ${ai} microphones, ${vi} cameras, ${ao} speakers.`);
        }
    }

    renderMediaDeviceOptions(selectElement, devices, selectedId, emptyLabel) {
        if (!selectElement) return;
        const safeDevices = Array.isArray(devices) ? devices : [];
        const options = ['<option value="">Default</option>'];
        for (const device of safeDevices) {
            const id = escapeHtml(String(device.deviceId || '').trim());
            const label = escapeHtml(String(device.label || `${emptyLabel} ${safeDevices.indexOf(device) + 1}`));
            options.push(`<option value="${id}">${label}</option>`);
        }
        selectElement.innerHTML = options.join('');
        selectElement.value = String(selectedId || '');
    }

    renderMediaSettingsPanel() {
        const settings = this.state.mediaSettings;
        this.renderMediaDeviceOptions(this.audioInputSelect, this.mediaDevices.audioInput, settings.audioInputDeviceId, 'Microphone');
        this.renderMediaDeviceOptions(this.videoInputSelect, this.mediaDevices.videoInput, settings.videoInputDeviceId, 'Camera');
        this.renderMediaDeviceOptions(this.audioOutputSelect, this.mediaDevices.audioOutput, settings.audioOutputDeviceId, 'Speaker');
        if (this.echoCancellationInput) this.echoCancellationInput.checked = Boolean(settings.echoCancellation);
        if (this.noiseSuppressionInput) this.noiseSuppressionInput.checked = Boolean(settings.noiseSuppression);
        if (this.autoGainControlInput) this.autoGainControlInput.checked = Boolean(settings.autoGainControl);
        if (this.mediaSettingsPanel) {
            this.mediaSettingsPanel.classList.toggle('webmeet-hidden', !this.state.mediaSettingsPanelVisible);
        }
        if (this.mediaSettingsButton) {
            this.mediaSettingsButton.classList.toggle('active', this.state.mediaSettingsPanelVisible);
        }
    }

    toggleMediaSettings() {
        this.state.mediaSettingsPanelVisible = !this.state.mediaSettingsPanelVisible;
        this.renderMediaSettingsPanel();
        if (this.state.mediaSettingsPanelVisible) {
            void this.refreshMediaDevices({ requestPermission: false, showToast: false });
        }
    }

    collectMediaSettingsFromInputs() {
        return {
            audioInputDeviceId: String(this.audioInputSelect?.value || '').trim(),
            videoInputDeviceId: String(this.videoInputSelect?.value || '').trim(),
            audioOutputDeviceId: String(this.audioOutputSelect?.value || '').trim(),
            echoCancellation: Boolean(this.echoCancellationInput?.checked),
            noiseSuppression: Boolean(this.noiseSuppressionInput?.checked),
            autoGainControl: Boolean(this.autoGainControlInput?.checked)
        };
    }

    async applyAudioOutputDeviceToElement(mediaElement) {
        const outputId = String(this.state.mediaSettings.audioOutputDeviceId || '').trim();
        if (!mediaElement || typeof mediaElement.setSinkId !== 'function') {
            return;
        }
        try {
            await mediaElement.setSinkId(outputId || '');
        } catch (_) {
            // ignore output routing errors
        }
    }

    async applyAudioOutputDeviceToAllTracks() {
        const entries = this.participantLayoutController.getTrackEntries();
        const tasks = [];
        for (const entry of entries) {
            if (entry?.kind !== 'audio' || !entry.element) continue;
            tasks.push(this.applyAudioOutputDeviceToElement(entry.element));
        }
        await Promise.allSettled(tasks);
    }

    async reapplyActiveInputDevices() {
        if (!this.room?.localParticipant) return;
        if (this.state.media.microphone) {
            try {
                await this.room.localParticipant.setMicrophoneEnabled(false);
                const micOptions = this.mediaController.getMicrophoneEnableOptions();
                await this.room.localParticipant.setMicrophoneEnabled(true, micOptions);
            } catch (_) {
                // ignore input restart errors
            }
        }
        if (this.state.media.camera) {
            try {
                await this.room.localParticipant.setCameraEnabled(false);
                const camOptions = this.mediaController.getCameraEnableOptions();
                await this.room.localParticipant.setCameraEnabled(true, camOptions);
            } catch (_) {
                // ignore input restart errors
            }
        }
    }

    async applyMediaSettings() {
        this.state.mediaSettings = this.collectMediaSettingsFromInputs();
        this.mediaController.setSettings(this.state.mediaSettings);
        this.persistMediaSettings();
        await this.applyAudioOutputDeviceToAllTracks();
        await this.reapplyActiveInputDevices();
        this.state.mediaSettingsPanelVisible = false;
        this.renderMediaSettingsPanel();
        this.setError('Media settings applied.');
    }

    toggleVideoGridFullscreen() {
        const isJoined = Boolean(this.state.session?.participantIdentity);
        if (!isJoined) {
            this.setError('Join a meeting before entering video fullscreen.');
            return;
        }
        this.state.videoGridFullscreen = !this.state.videoGridFullscreen;
        this.applyVideoGridFullscreenMode();
    }

    getParticipantDisplayName(participant) {
        return String(
            participant?.name
            || participant?.displayName
            || participant?.identity
            || 'Participant'
        ).trim() || 'Participant';
    }

    setVideoGridEmptyState(message) {
        this.participantLayoutController.setVideoGridEmptyState(message);
    }

    syncVideoGridVisibility() {
        this.participantLayoutController.syncVideoGridVisibility();
    }

    applyParticipantViewState(view) {
        this.participantLayoutController.applyParticipantViewState(view);
    }

    upsertParticipantView(participant) {
        return this.participantLayoutController.upsertParticipantView(participant);
    }

    renderParticipantLayout() {
        this.participantLayoutController.renderParticipantLayout();
    }

    setFocusedParticipant(participantId) {
        this.participantLayoutController.setFocusedParticipant(participantId);
    }

    focusParticipantCard(target) {
        this.participantLayoutController.focusParticipantCard(target);
    }

    setParticipantMicState(participantId, isMicOn) {
        this.participantLayoutController.setParticipantMicState(participantId, isMicOn);
        const id = String(participantId || '').trim();
        if (!id) return;
        let updated = false;
        const nextMicState = Boolean(isMicOn);
        const map = this.state.meetingParticipantsById || {};
        for (const meetingId of Object.keys(map)) {
            const entries = Array.isArray(map[meetingId]) ? map[meetingId] : [];
            for (const entry of entries) {
                if (String(entry?.id || '').trim() !== id) continue;
                if (entry.micOn !== nextMicState) {
                    entry.micOn = nextMicState;
                    updated = true;
                }
            }
        }
        if (updated) {
            this.renderMeetingList();
        }
    }

    attachVideoTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachVideoTrack(participantId, trackSid, mediaElement);
    }

    clearVideoTrack(trackSid) {
        this.participantLayoutController.clearVideoTrack(trackSid);
    }

    attachAudioTrack(participantId, trackSid, mediaElement) {
        this.participantLayoutController.attachAudioTrack(participantId, trackSid, mediaElement);
    }

    removeTrack(trackSid) {
        this.participantLayoutController.removeTrack(trackSid);
    }

    removeParticipantView(participantId) {
        this.participantLayoutController.removeParticipantView(participantId);
    }

    isParticipantMicOn(participant, Track) {
        if (!participant?.trackPublications?.values) return false;
        for (const publication of participant.trackPublications.values()) {
            if (!publication) continue;
            const isAudioKind = publication.kind === Track.Kind.Audio;
            const isMicSource = publication.source === Track.Source.Microphone;
            if (isAudioKind || isMicSource) {
                return !publication.isMuted;
            }
        }
        return false;
    }

    syncParticipantsFromRoom(room, Track) {
        if (!room) return;
        const items = [{
            identity: room.localParticipant?.identity || this.state.session?.participantIdentity || '',
            name: room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
            kind: 'local'
        }];
        for (const participant of room.remoteParticipants.values()) {
            items.push({
                identity: participant.identity || '',
                name: participant.name || participant.identity || 'Remote',
                kind: 'remote'
            });
        }

        const keep = new Set();
        for (const item of items) {
            const id = String(item.identity || '').trim();
            if (!id) continue;
            keep.add(id);
            const view = this.upsertParticipantView(item);
            if (!view) continue;
            const sourceParticipant = item.kind === 'local' ? room.localParticipant : room.remoteParticipants.get(id);
            view.micOn = this.isParticipantMicOn(sourceParticipant, Track);
            this.applyParticipantViewState(view);
        }

        for (const participantId of this.participantLayoutController.getParticipantIds()) {
            if (!keep.has(participantId)) {
                this.removeParticipantView(participantId);
            }
        }

        this.state.participants = items;
        if (this.selectedMeeting?.id) {
            this.state.meetingParticipantsById[this.selectedMeeting.id] = items.map((entry) => ({
                id: entry.identity,
                name: entry.name,
                micOn: Boolean(
                    this.participantLayoutController
                        .getParticipantView?.(entry.identity)
                        ?.micOn
                )
            })).filter((entry) => entry.id);
            this.renderMeetingList();
        }
        this.renderParticipantLayout();
        this.syncLocalMediaStateFromRoom(Track);
        this.renderFeedLists();
    }

    syncLocalMediaStateFromRoom(TrackRef = null) {
        this.mediaController.syncLocalMediaStateFromRoom(TrackRef);
    }

    afterUnload() {
        this.element.removeEventListener('click', this.handleClick);
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
            await this.loadWorkspaces();
            this.state.selectedWorkspaceId = this.state.workspaces[0]?.id || '';
            if (this.state.selectedWorkspaceId) {
                await this.loadMeetings();
            }
            this.renderAll();
        } catch (error) {
            console.error('[webmeet] bootstrap failed', error);
            this.setError(error instanceof Error ? error.message : String(error));
        }
    }

    get selectedMeeting() {
        return this.state.meetings.find((entry) => entry.id === this.state.selectedMeetingId) || null;
    }

    get currentActor() {
        return normalizeCurrentActor();
    }

    canManageRooms() {
        return isAdminActor(this.currentActor);
    }

    async loadWorkspaces() {
        const payload = await runTool('webmeet_workspace_list');
        this.state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    }

    async loadMeetings() {
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
        await this.loadParticipantsForMeetings();
        this.state.selectedMeetingId = this.state.meetings.some((entry) => entry.id === this.state.selectedMeetingId)
            ? this.state.selectedMeetingId
            : '';
        await this.loadMeetingDetails();
    }

    async loadParticipantsForMeetings() {
        const meetings = Array.isArray(this.state.meetings) ? this.state.meetings : [];
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
            const participants = Array.isArray(result.value?.participants) ? result.value.participants : [];
            nextMap[meeting.id] = participants.map((entry) => ({
                id: String(entry?.id || '').trim(),
                name: String(entry?.displayName || entry?.id || 'Participant').trim() || 'Participant',
                micOn: typeof entry?.micOn === 'boolean' ? entry.micOn : false
            }));
        }
        this.state.meetingParticipantsById = nextMap;
    }

    async loadMeetingDetails() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
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
        const [chatPayload, transcriptPayload, artifactPayload, agentPayload] = await Promise.all([
            runTool('webmeet_chat_list', { meetingId: meeting.id }),
            runTool('webmeet_transcript_list', { meetingId: meeting.id }),
            runTool('webmeet_artifact_list', { meetingId: meeting.id }),
            runTool('webmeet_agent_list', { meetingId: meeting.id })
        ]);
        this.state.chat = Array.isArray(chatPayload.messages) ? chatPayload.messages : [];
        this.state.transcript = Array.isArray(transcriptPayload.transcript) ? transcriptPayload.transcript : [];
        this.state.artifacts = Array.isArray(artifactPayload.artifacts) ? artifactPayload.artifacts : [];
        this.state.recordings = Array.isArray(artifactPayload.recordings) ? artifactPayload.recordings : [];
        this.state.tasks = Array.isArray(artifactPayload.tasks) ? artifactPayload.tasks : [];
        this.state.decisions = Array.isArray(artifactPayload.decisions) ? artifactPayload.decisions : [];
        this.state.agents = Array.isArray(agentPayload.agents) ? agentPayload.agents : [];
    }

    renderAll() {
        const canManageRooms = this.canManageRooms();
        const hasSelection = Boolean(this.selectedMeeting);
        if (this.createRoomButton) {
            this.createRoomButton.classList.toggle('webmeet-hidden', !canManageRooms);
        }
        if (this.renameRoomButton) {
            this.renameRoomButton.classList.toggle('webmeet-hidden', !(canManageRooms && hasSelection));
        }
        if (this.closeRoomButton) {
            this.closeRoomButton.classList.toggle('webmeet-hidden', !(canManageRooms && hasSelection));
        }
        this.renderWorkspaceList();
        this.renderMeetingList();
        this.renderMeetingSummary();
        this.renderFeedLists();
    }

    setError(message) {
        const msg = String(message || '').trim();
        if (!msg) return;

        // Use local toast container inside modal
        if (this.toastContainer) {
            const toast = document.createElement('div');
            toast.className = 'webmeet-toast';
            toast.textContent = msg;
            this.toastContainer.appendChild(toast);
            setTimeout(() => {
                toast.remove();
            }, 3000);
            return;
        }

        // Fallback to global toast services
        if (typeof window.assistOS?.showToast === 'function') {
            window.assistOS.showToast(msg, 'error', 3000);
        } else if (typeof window.uiService?.showToast === 'function') {
            window.uiService.showToast(msg, { type: 'error', duration: 3000 });
        } else {
            alert(msg);
        }
    }

    renderWorkspaceList() {
        this.workspaceList.innerHTML = this.state.workspaces.map((entry) => `
            <div class="webmeet-list-item ${entry.id === this.state.selectedWorkspaceId ? 'is-selected' : ''}">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.name)}</strong>
                </div>
                <div>${escapeHtml(entry.rootPath || '')}</div>
            </div>
        `).join('') || '<div class="webmeet-feed-item">Workspace unavailable.</div>';

        // Update workspace indicator
        const currentWorkspace = this.state.workspaces[0];
        if (currentWorkspace && this.currentWorkspace) {
            this.currentWorkspace.textContent = currentWorkspace.name;
        }
    }

    renderMeetingList() {
        this.meetingListController.render(
            this.state.meetings,
            this.state.selectedMeetingId,
            this.state.meetingParticipantsById
        );
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

    renderMeetingSummary() {
        const meeting = this.selectedMeeting;
        const isJoined = !!this.state.session?.participantIdentity;
        
        // Toggle welcome screen vs meeting UI
        if (this.welcomeScreen) {
            this.welcomeScreen.classList.toggle('webmeet-hidden', isJoined);
        }
        if (this.meetingBar) {
            this.meetingBar.classList.toggle('webmeet-hidden', !isJoined);
        }
        if (this.mainContent) {
            this.mainContent.classList.toggle('webmeet-hidden', !isJoined);
        }
        if (this.secondaryPanels) {
            this.secondaryPanels.classList.toggle('webmeet-hidden', !isJoined);
        }
        if (!isJoined && this.state.videoGridFullscreen) {
            this.state.videoGridFullscreen = false;
        }
        this.applyChatSidebarVisibility();
        this.applyVideoGridFullscreenMode();
        
        this.meetingTitle.textContent = meeting?.title || 'None';
        this.meetingMeta.textContent = meeting ? formatDate(meeting.createdAt) : '';
        this.lifecycle.textContent = meeting?.status || 'Idle';
        this.joinStatus.textContent = isJoined ? 'Joined' : 'Not joined';
        this.joinPayload.value = this.state.session ? JSON.stringify(this.state.session, null, 2) : '';
        this.roomConnectionState.textContent = `${this.state.roomState} · transcript ${this.state.transcriptState}`;

        // Update recording button
        const latestRecording = [...this.state.recordings].reverse()[0] || null;
        if (this.recordingButton) {
            if (latestRecording && latestRecording.status === 'recording') {
                this.recordingButton.classList.add('active');
                this.recordingButton.title = 'Stop recording';
                this.recordingButton.setAttribute('aria-label', 'Stop recording');
            } else {
                this.recordingButton.classList.remove('active');
                this.recordingButton.title = 'Start recording';
                this.recordingButton.setAttribute('aria-label', 'Start recording');
            }
        }

        if (meeting && latestRecording) {
            this.meetingMeta.textContent = `${this.meetingMeta.textContent} · rec ${latestRecording.status}`;
        }

        // Update icon button states
        if (this.micButton) {
            this.micButton.classList.toggle('active', this.state.media.microphone);
        }
        if (this.cameraButton) {
            this.cameraButton.classList.toggle('active', this.state.media.camera);
        }
        if (this.screenShareButton) {
            this.screenShareButton.classList.toggle('active', this.state.media.screen);
        }
    }

    renderFeedLists() {
        const renderFeed = (target, entries, formatter, shouldScroll = false, emptyHtml = '<div class="webmeet-feed-item">No data yet.</div>') => {
            target.innerHTML = entries.map(formatter).join('') || emptyHtml;
            if (shouldScroll) {
                target.scrollTop = target.scrollHeight;
            }
        };

        renderFeed(this.chatList, this.state.chat, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-chat-entry ${
                    String(entry.authorId || '').trim() === String(this.state.session?.participantIdentity || '').trim()
                        ? 'webmeet-chat-entry-self'
                        : ''
                }">
                    <div class="webmeet-chat-message-content">
                        <div class="webmeet-chat-meta">
                            <strong class="webmeet-chat-author">${escapeHtml(entry.authorName || entry.authorId || 'unknown')}</strong>
                            <span class="webmeet-chat-time">${escapeHtml(formatDate(entry.createdAt))}</span>
                        </div>
                        <div class="webmeet-chat-text">${escapeHtml(entry.message || '')}</div>
                    </div>
                </div>
            </div>
        `, true, '<div class="webmeet-chat-empty">No messages yet. Start the conversation.</div>');

        renderFeed(this.transcriptList, this.state.transcript, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.speakerName || entry.speakerId || 'speaker')}</strong>
                    <span>${escapeHtml(formatDate(entry.createdAt))}</span>
                </div>
                <div>${escapeHtml(entry.text || '')}</div>
            </div>
        `);
        renderFeed(this.artifactList, this.state.artifacts, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.title || entry.type || 'artifact')}</strong>
                    <span>${escapeHtml(formatDate(entry.createdAt))}</span>
                </div>
                <pre class="webmeet-code">${escapeHtml(entry.body || '')}</pre>
            </div>
        `);
        renderFeed(this.recordingList, this.state.recordings, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.id || 'recording')}</strong>
                    <span>${escapeHtml(entry.status || '')}</span>
                </div>
                <div>${escapeHtml(entry.filePath || '')}</div>
                <div>${escapeHtml(formatDate(entry.startedAt || entry.createdAt))}</div>
            </div>
        `);
        renderFeed(this.taskList, this.state.tasks, (entry) => `
            <div class="webmeet-feed-item">
                <strong>${escapeHtml(entry.title || '')}</strong>
                <div>${escapeHtml(entry.status || '')}</div>
            </div>
        `);
        renderFeed(this.decisionList, this.state.decisions, (entry) => `
            <div class="webmeet-feed-item">
                <strong>${escapeHtml(entry.title || '')}</strong>
            </div>
        `);
        renderFeed(this.agentList, this.state.agents, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.agentType || '')}</strong>
                    <span>${escapeHtml(entry.mode || '')}</span>
                </div>
            </div>
        `);
    }

    async selectMeeting(element) {
        this.state.selectedMeetingId = element.dataset.id || '';
        await this.loadMeetingDetails();
        this.renderAll();
    }

    async selectAndJoinMeeting(element) {
        const nextMeetingId = String(element?.dataset?.id || '').trim();
        if (!nextMeetingId) return;
        const currentMeetingId = String(this.state.session?.meeting?.id || '').trim();
        const currentlyJoined = Boolean(this.state.session?.participantIdentity);
        const switchingRoom = Boolean(currentlyJoined && currentMeetingId && currentMeetingId !== nextMeetingId);
        if (currentlyJoined && currentMeetingId === nextMeetingId) {
            this.state.selectedMeetingId = nextMeetingId;
            await this.loadMeetingDetails();
            this.renderAll();
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
        await this.loadMeetingDetails();
        this.renderAll();
        const defaultName = String(this.state.session?.participant?.displayName || '').trim();
        await this.joinMeeting({ displayNameOverride: defaultName });
    }

    async createMeeting() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can create rooms.');
            return;
        }
        if (!this.state.selectedWorkspaceId) {
            this.setError('Current Explorer workspace is unavailable.');
            return;
        }
        const title = window.prompt('Room title', 'Standup');
        if (!title) return;
        const meeting = await runTool('webmeet_meeting_create', {
            workspaceId: this.state.selectedWorkspaceId,
            title
        });
        this.state.selectedMeetingId = meeting?.id || this.state.selectedMeetingId;
        await this.loadMeetings();
        this.renderAll();
    }

    async renameMeeting() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can rename rooms.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a room before renaming it.');
            return;
        }
        const title = String(window.prompt('Room title', meeting.title || '') || '').trim();
        if (!title || title === meeting.title) {
            return;
        }
        const updated = await runTool('webmeet_meeting_rename', {
            meetingId: meeting.id,
            title
        });
        if (updated?.title) {
            const entry = this.state.meetings.find((item) => item.id === meeting.id);
            if (entry) {
                entry.title = updated.title;
                entry.updatedAt = updated.updatedAt || entry.updatedAt;
            }
        }
        await this.loadMeetings();
        this.renderAll();
    }

    async joinMeeting(options = {}) {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        const displayName = String(options.displayNameOverride || getCurrentActorDisplayName()).trim();
        const participantId = this.getStableParticipantId(displayName);
        const payload = { meetingId: meeting.id, participantId };
        if (displayName) {
            payload.displayName = displayName;
        }
        this.state.session = await runTool('webmeet_meeting_join', payload);
        try {
            await this.connectRoom();
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.state.roomState = message;
            this.setError(message);
        } finally {
            this.renderMeetingSummary();
        }
    }

    async connectRoom() {
        if (!this.state.session?.participantToken || !this.state.session?.livekitUrl) {
            this.state.roomState = 'Join payload missing media token';
            this.renderMeetingSummary();
            return;
        }
        await this.disconnectRoom();

        const renderPublication = (participant, publication, explicitTrack = null, TrackRef = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            if (!Track) return;
            const participantId = String(participant?.identity || '').trim();
            if (!participantId || !publication) return;
            this.upsertParticipantView({
                identity: participantId,
                name: this.getParticipantDisplayName(participant),
                kind: participantId === this.room?.localParticipant?.identity ? 'local' : 'remote'
            });
            const track = explicitTrack || publication.track;
            if (!track) return;
            const trackId = String(
                publication.trackSid
                || `${participantId}:${publication.source || publication.kind || track.kind || 'track'}`
            ).trim();
            if (!trackId) return;

            if (track.kind === Track.Kind.Video) {
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                if (participantId === this.room?.localParticipant?.identity) {
                    mediaElement.muted = true;
                }
                this.attachVideoTrack(participantId, trackId, mediaElement);
            } else if (track.kind === Track.Kind.Audio) {
                const isLocalParticipant = participantId === this.room?.localParticipant?.identity;
                if (!isLocalParticipant) {
                    const mediaElement = track.attach();
                    mediaElement.autoplay = true;
                    void this.applyAudioOutputDeviceToElement(mediaElement);
                    this.attachAudioTrack(participantId, trackId, mediaElement);
                }
                this.setParticipantMicState(participantId, !publication.isMuted);
            }
        };

        const removePublication = (publication, TrackRef = null) => {
            const Track = TrackRef || window.LivekitClient?.Track;
            const trackId = String(publication?.trackSid || '').trim();
            if (!trackId) return;
            const trackInfo = this.participantLayoutController.getTrackEntry(trackId);
            this.removeTrack(trackId);
            if (Track && (trackInfo?.kind === 'audio' || publication.kind === Track.Kind.Audio)) {
                const participantId = String(trackInfo?.participantId || '').trim();
                if (participantId) {
                    const participant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId);
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(participant, Track));
                }
            }
        };

        await this.roomController.connect(this.state.session, {
            onRoomCreated: ({ room }) => {
                this.room = room;
            },
            onConnecting: () => {
                this.state.roomState = 'Connecting';
                this.renderMeetingSummary();
            },
            onTrackSubscribed: (track, publication, participant, { Track }) => {
                renderPublication(participant, publication, track, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackUnsubscribed: (_track, publication, _participant, { Track }) => {
                removePublication(publication, Track);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onLocalTrackPublished: (publication, { room, Track }) => {
                renderPublication(room.localParticipant, publication, null, Track);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onLocalTrackUnpublished: (publication, { Track }) => {
                removePublication(publication, Track);
                this.syncLocalMediaStateFromRoom(Track);
                this.renderMeetingSummary();
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onRemoteTrackPublished: (publication, participant, { Track }) => {
                if (publication.isSubscribed && publication.track) {
                    renderPublication(participant, publication, publication.track, Track);
                } else if (!publication.isSubscribed && typeof publication.setSubscribed === 'function') {
                    publication.setSubscribed(true);
                }
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onParticipantConnected: (_participant, { Track }) => {
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onParticipantDisconnected: (participant, { Track }) => {
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication, Track);
                }
                this.removeParticipantView(participant.identity);
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onTrackMuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    removePublication(publication, Track);
                } else {
                    this.setParticipantMicState(participantId, false);
                }
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                }
            },
            onTrackUnmuted: (publication, participant, { Track }) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    renderPublication(participant, publication, publication?.track || null, Track);
                }
                const sourceParticipant = participantId === this.room?.localParticipant?.identity
                    ? this.room.localParticipant
                    : this.room?.remoteParticipants?.get?.(participantId) || participant;
                this.setParticipantMicState(participantId, this.isParticipantMicOn(sourceParticipant, Track));
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                    this.renderMeetingSummary();
                }
                this.syncParticipantsFromRoom(this.room, Track);
            },
            onDataReceived: (payload, participant) => {
                console.log('[WebMeet] DataReceived event fired, participant:', participant?.identity);
                try {
                    const text = new TextDecoder().decode(payload);
                    console.log('[WebMeet] DataReceived payload:', text.substring(0, 200));
                    const data = JSON.parse(text);
                    console.log('[WebMeet] DataReceived parsed:', data);
                    if (data.type === 'chat' && data.meetingId === this.selectedMeeting?.id) {
                        if (!this.state.chat) this.state.chat = [];
                        this.state.chat.push(data.message);
                        console.log('[WebMeet] Added message to state.chat, count:', this.state.chat.length);
                        this.renderFeedLists();
                    }
                } catch (err) {
                    console.error('[WebMeet] DataReceived error:', err);
                }
            },
            onDisconnected: () => {
                this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: false });
            },
            onConnected: ({ room, Track }) => {
                this.state.roomState = 'Connected';
                this.syncParticipantsFromRoom(this.room, Track);
                for (const participant of room.remoteParticipants.values()) {
                    for (const publication of participant.trackPublications.values()) {
                        if (publication.isSubscribed && publication.track) {
                            renderPublication(participant, publication, publication.track, Track);
                        } else if (!publication.isSubscribed && typeof publication.setSubscribed === 'function') {
                            publication.setSubscribed(true);
                        }
                    }
                }
                this.startPresenceHeartbeat();
                this.renderMeetingSummary();
            },
            onConnectError: (error) => {
                this.state.roomState = error instanceof Error ? error.message : String(error);
                this.stopPresenceHeartbeat();
                this.renderMeetingSummary();
            }
        });
    }

    resetRoomUiState(options = {}) {
        const forceRenderAll = Boolean(options.forceRenderAll);
        const applyVideoFullscreenMode = Boolean(options.applyVideoFullscreenMode);
        this.room = this.roomController.getRoom();
        this.stopPresenceHeartbeat();
        this.mediaController.reset();
        this.state.roomState = 'Disconnected';
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
        this.state.videoGridFullscreen = false;
        this.participantLayoutController.clearAll('Join a meeting to attach media tracks.');
        if (applyVideoFullscreenMode) {
            this.applyVideoGridFullscreenMode();
        }
        if (forceRenderAll) {
            this.renderAll();
        } else {
            this.renderMeetingSummary();
            this.renderFeedLists();
        }
    }

    async disconnectRoom() {
        if (!this.roomController.getRoom()) return;
        await this.roomController.disconnect();
        this.resetRoomUiState({ forceRenderAll: true, applyVideoFullscreenMode: true });
    }

    async toggleMicrophone() {
        await this.mediaController.toggleMicrophone();
    }

    async toggleCamera() {
        await this.mediaController.toggleCamera();
    }

    async toggleScreenShare() {
        await this.mediaController.toggleScreenShare();
    }

    async leaveMeeting() {
        await this.unjoinCurrentSession({ preserveDisplayName: false });
    }

    async unjoinCurrentSession(options = {}) {
        const preserveDisplayName = Boolean(options.preserveDisplayName);
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        const preservedName = String(this.state.session?.participant?.displayName || '').trim();
        this.stopPresenceHeartbeat();

        if (previousMeetingId && previousParticipantId) {
            try {
                await runTool('webmeet_meeting_leave', {
                    meetingId: previousMeetingId,
                    participantId: previousParticipantId
                });
            } catch (error) {
                console.warn('[webmeet] leave participant failed', error);
            }
        }

        this.removeParticipantFromMeetingList(previousMeetingId, previousParticipantId);
        this.stopSpeechRecognition();
        await this.disconnectRoom();
        this.state.session = preserveDisplayName && preservedName ? { participant: { displayName: preservedName } } : null;
        await this.loadParticipantsForMeetings();
        this.renderAll();
    }

    async sendChat() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        if (!this.state.session?.participantIdentity) {
            this.setError('Join the meeting before sending chat messages.');
            return;
        }
        const message = String(this.chatInput?.value || '').trim();
        if (!message) return;
        
        console.log('[WebMeet] sendChat - room state:', this.room?.state, 'localParticipant:', !!this.room?.localParticipant);
        
        await runTool('webmeet_chat_send', {
            meetingId: meeting.id,
            authorId: this.state.session.participantIdentity,
            authorName: this.state.session.participant?.displayName || 'User',
            message
        });
        this.chatInput.value = '';
        
        // Always reload from server immediately
        await this.loadMeetingDetails();
        this.renderFeedLists();
        
        // Also try to broadcast via LiveKit data channel for other participants
        if (this.room?.localParticipant) {
            try {
                const chatPayload = {
                    type: 'chat',
                    meetingId: meeting.id,
                    message: {
                        authorId: this.state.session.participantIdentity,
                        authorName: this.state.session.participant?.displayName || 'User',
                        message,
                        createdAt: new Date().toISOString()
                    }
                };
                console.log('[WebMeet] Publishing data:', chatPayload);
                const encoder = new TextEncoder();
                // Try multiple approaches for DataPacket_Kind
                let kindValue = 0;
                if (window.LivekitClient?.DataPacket_Kind?.RELIABLE !== undefined) {
                    kindValue = window.LivekitClient.DataPacket_Kind.RELIABLE;
                }
                console.log('[WebMeet] DataPacket_Kind value:', kindValue, 'LivekitClient:', !!window.LivekitClient);
                await this.room.localParticipant.publishData(encoder.encode(JSON.stringify(chatPayload)), kindValue);
                console.log('[WebMeet] Data published successfully');
            } catch (err) {
                console.error('[WebMeet] Failed to publish data (non-critical):', err);
            }
        }
    }

    async appendTranscript() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        if (!this.state.session?.participantIdentity) {
            this.setError('Join the meeting before appending transcript.');
            return;
        }
        const text = String(this.transcriptInput?.value || '').trim();
        const speakerName = String(this.transcriptSpeaker?.value || this.state.session.participant?.displayName || '').trim();
        if (!text || !speakerName) return;
        await runTool('webmeet_transcript_append', {
            meetingId: meeting.id,
            speakerId: this.state.session.participantIdentity,
            speakerName,
            text
        });
        this.transcriptInput.value = '';
        await this.loadMeetingDetails();
        this.renderAll();
    }

    startSpeechRecognition() {
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            this.state.transcriptState = 'Unavailable';
            this.renderMeetingSummary();
            return;
        }
        this.stopSpeechRecognition();
        const recognition = new Recognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = navigator.language || 'en-US';
        recognition.onstart = () => {
            this.state.transcriptState = 'Listening';
            this.renderMeetingSummary();
        };
        recognition.onerror = () => {
            this.state.transcriptState = 'Error';
            this.renderMeetingSummary();
        };
        recognition.onend = () => {
            if (this.speechRecognition === recognition) {
                this.state.transcriptState = 'Stopped';
                this.speechRecognition = null;
                this.renderMeetingSummary();
            }
        };
        recognition.onresult = async (event) => {
            const meeting = this.selectedMeeting;
            if (!meeting || !this.state.session?.participantIdentity) return;
            const chunks = [];
            for (let index = event.resultIndex; index < event.results.length; index += 1) {
                const result = event.results[index];
                if (result.isFinal && result[0]?.transcript) {
                    chunks.push(String(result[0].transcript || '').trim());
                }
            }
            const text = chunks.join(' ').trim();
            if (!text) return;
            await runTool('webmeet_transcript_append', {
                meetingId: meeting.id,
                speakerId: this.state.session.participantIdentity,
                speakerName: this.state.session.participant?.displayName || 'User',
                text
            });
            await this.loadMeetingDetails();
            this.renderAll();
        };
        this.speechRecognition = recognition;
        recognition.start();
    }

    stopSpeechRecognition() {
        if (!this.speechRecognition) return;
        try {
            this.speechRecognition.stop();
        } catch (_) {
            // ignore
        }
        this.speechRecognition = null;
        this.state.transcriptState = 'Stopped';
        this.renderMeetingSummary();
    }

    async startAutoTranscript() {
        this.startSpeechRecognition();
    }

    async stopAutoTranscript() {
        this.stopSpeechRecognition();
    }

    async attachObserver() {
        await this.attachAgent('observer', 'passive');
    }

    async attachAssistant() {
        await this.attachAgent('assistant_on_mention', 'on_mention');
    }

    async attachScribe() {
        await this.attachAgent('scribe', 'post_event');
    }

    async attachAgent(agentType, mode) {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before attaching AI agents.');
            return;
        }
        await runTool('webmeet_agent_attach', { meetingId: meeting.id, agentType, mode });
        await this.loadMeetingDetails();
        this.renderAll();
    }

    async startRecording() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before starting recording.');
            return;
        }
        await runTool('webmeet_recording_start', { meetingId: meeting.id });
        await this.loadMeetingDetails();
        this.renderAll();
    }

    async stopRecording() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before stopping recording.');
            return;
        }
        await runTool('webmeet_recording_stop', { meetingId: meeting.id });
        await this.loadMeetingDetails();
        this.renderAll();
    }

    async toggleRecording() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before toggling recording.');
            return;
        }

        const latestRecording = [...this.state.recordings].reverse()[0];
        if (latestRecording && latestRecording.status === 'recording') {
            await this.stopRecording();
        } else {
            await this.startRecording();
        }
    }

    async closeMeeting() {
        if (!this.canManageRooms()) {
            this.setError('Only admin can delete rooms.');
            return;
        }
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a room before deleting it.');
            return;
        }
        await runTool('webmeet_close_meeting', { meetingId: meeting.id });
        await this.loadMeetings();
        this.renderAll();
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
