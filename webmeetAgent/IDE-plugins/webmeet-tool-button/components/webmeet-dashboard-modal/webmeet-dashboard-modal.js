import { callAgentTool, ensureSuccess, parseToolResult } from "/explorer/services/infrastructure/explorerApi.js";

const AGENT_NAME = 'webmeetAgent';
const LIVEKIT_UMD_URL = new URL('../../vendor/livekit-client.umd.min.js', import.meta.url).href;

let livekitLoadPromise = null;

async function runTool(name, args = {}) {
    const raw = await callAgentTool(AGENT_NAME, name, args, { raw: true });
    ensureSuccess(raw);
    const parsed = parseToolResult(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
}

async function ensureLiveKitClient() {
    if (window.LivekitClient) {
        return window.LivekitClient;
    }
    if (!livekitLoadPromise) {
        livekitLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = LIVEKIT_UMD_URL;
            script.async = true;
            script.onload = () => {
                if (window.LivekitClient) {
                    resolve(window.LivekitClient);
                    return;
                }
                reject(new Error('LiveKit SDK did not register a global.'));
            };
            script.onerror = () => reject(new Error('Failed to load LiveKit SDK.'));
            document.head.appendChild(script);
        });
    }
    return livekitLoadPromise;
}

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

function buildRtcConfigForSession(session) {
    const livekitUrl = String(session?.livekitUrl || '').trim();
    if (!livekitUrl) return undefined;
    let parsed;
    try {
        parsed = new URL(livekitUrl);
    } catch {
        return undefined;
    }
    const hostname = String(parsed.hostname || '').trim().toLowerCase();
    if (!hostname || !['127.0.0.1', 'localhost'].includes(hostname)) {
        return undefined;
    }
    return {
        iceTransportPolicy: 'relay',
        iceServers: [
            { urls: ['stun:127.0.0.1:13478'] },
            {
                urls: [
                    'turn:127.0.0.1:13478?transport=udp',
                    'turn:127.0.0.1:13478?transport=tcp'
                ],
                username: 'webmeet',
                credential: 'webmeet'
            }
        ]
    };
}

function installRtcPeerConnectionOverride(session) {
    const forcedConfig = buildRtcConfigForSession(session);
    if (!forcedConfig || typeof window === 'undefined' || typeof window.RTCPeerConnection !== 'function') {
        return null;
    }

    const NativePeerConnection = window.RTCPeerConnection;
    if (NativePeerConnection.__webmeetForcedRelay) {
        return null;
    }

    const ForcedPeerConnection = function(configuration = {}, ...rest) {
        const mergedConfiguration = {
            ...(configuration || {}),
            iceTransportPolicy: forcedConfig.iceTransportPolicy,
            iceServers: forcedConfig.iceServers
        };
        console.debug('[webmeet] forcing RTCPeerConnection config', {
            originalConfiguration: configuration || {},
            mergedConfiguration
        });
        return new NativePeerConnection(mergedConfiguration, ...rest);
    };

    ForcedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.setPrototypeOf(ForcedPeerConnection, NativePeerConnection);
    ForcedPeerConnection.__webmeetForcedRelay = true;

    window.RTCPeerConnection = ForcedPeerConnection;
    console.debug('[webmeet] installed RTCPeerConnection relay override', forcedConfig);
    return () => {
        if (window.RTCPeerConnection === ForcedPeerConnection) {
            window.RTCPeerConnection = NativePeerConnection;
            console.debug('[webmeet] restored native RTCPeerConnection');
        }
    };
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
            participants: [],
            chatSidebarVisible: true,
            videoGridFullscreen: false
        };
        this.room = null;
        this.restoreRtcPeerConnection = null;
        this.speechRecognition = null;
        this.trackElements = new Map();
        this.participantViews = new Map();
        this.focusedParticipantId = '';
        this.mediaToggleInFlight = false;
        this.pollingInterval = null;
        this.invalidate();
    }

    beforeRender() {}

    async afterRender() {
        this.cacheElements();
        this.registerActions();
        await this.bootstrap();
    }

    registerActions() {
        // Register actions with WebSkel if available
        if (this.hostContext && typeof this.hostContext.registerAction === 'function') {
            const actions = [
                'closeModal',
                'createMeeting',
                'joinMeeting',
                'leaveMeeting',
                'toggleRecording',
                'toggleMicrophone',
                'toggleCamera',
                'toggleScreenShare',
                'toggleVideoGridFullscreen',
                'toggleFullscreen',
                'toggleChatSidebar',
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
        this.toggleChatButton = this.element.querySelector('#webmeetToggleChatButton');
        this.fullscreenButton = this.element.querySelector('#webmeetModalFullscreen');
        this.welcomeScreen = this.element.querySelector('#webmeetWelcomeScreen');
        this.meetingBar = this.element.querySelector('.webmeet-meeting-bar');
        this.mainContent = this.element.querySelector('.webmeet-main-content');
        this.secondaryPanels = this.element.querySelector('.webmeet-secondary-panels');
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
        if (this.videoGridEmpty) {
            this.videoGridEmpty.textContent = String(message || 'Join a meeting to attach media tracks.');
        }
    }

    syncVideoGridVisibility() {
        const participantCount = this.participantViews.size;
        const hasParticipants = participantCount > 0;
        const hasFocusedParticipant = Boolean(this.focusedParticipantId && this.participantViews.has(this.focusedParticipantId));
        if (this.videoGridEmpty) {
            this.videoGridEmpty.classList.toggle('webmeet-hidden', hasParticipants);
        }
        if (this.videoGridAll) {
            this.videoGridAll.classList.toggle('webmeet-hidden', !hasParticipants);
            this.videoGridAll.classList.toggle('has-focus', hasFocusedParticipant);
        }
    }

    applyParticipantViewState(view) {
        if (!view || !view.element) return;
        const payload = {
            participantId: view.id,
            displayName: view.name,
            isLocal: Boolean(view.isLocal),
            isMicOn: Boolean(view.micOn),
            hasVideo: Boolean(view.hasVideo),
            isMini: Boolean(view.isMini),
            isFocused: Boolean(view.isFocused)
        };
        view.element.dataset.participantId = payload.participantId;
        view.element.setAttribute('data-display-name', payload.displayName);
        view.element.setAttribute('data-is-local', payload.isLocal ? 'true' : 'false');
        view.element.setAttribute('data-is-mic-on', payload.isMicOn ? 'true' : 'false');
        view.element.setAttribute('data-has-video', payload.hasVideo ? 'true' : 'false');
        view.element.setAttribute('data-is-mini', payload.isMini ? 'true' : 'false');
        view.element.setAttribute('data-is-focused', payload.isFocused ? 'true' : 'false');
        const presenter = view.element.webSkelPresenter;
        if (presenter && typeof presenter.setState === 'function') {
            presenter.setState(payload);
        }
        if (view.videoElement) {
            if (presenter && typeof presenter.setVideoElement === 'function') {
                presenter.setVideoElement(view.videoElement);
            } else {
                const mediaHost = view.element.querySelector('[data-role="mediaHost"]');
                if (mediaHost && !mediaHost.contains(view.videoElement)) {
                    mediaHost.appendChild(view.videoElement);
                }
            }
        }
    }

    upsertParticipantView(participant) {
        const id = String(participant?.identity || '').trim();
        if (!id || !this.videoGrid) return null;
        let view = this.participantViews.get(id);
        if (!view) {
            const element = document.createElement('webmeet-participant-card');
            element.setAttribute('data-presenter', 'webmeet-participant-card');
            element.setAttribute('data-local-action', 'focusParticipantCard');
            element.dataset.participantId = id;
            element.title = 'Focus participant';
            view = {
                id,
                name: this.getParticipantDisplayName(participant),
                isLocal: Boolean(participant.kind === 'local'),
                hasVideo: false,
                micOn: false,
                isMini: true,
                isFocused: false,
                element
            };
            this.participantViews.set(id, view);
        } else {
            view.name = this.getParticipantDisplayName(participant);
            view.isLocal = Boolean(participant.kind === 'local');
        }
        this.applyParticipantViewState(view);
        return view;
    }

    renderParticipantLayout() {
        if (!this.videoGrid || !this.videoGridAll) return;
        if (!this.participantViews.size) {
            this.focusedParticipantId = '';
            this.syncVideoGridVisibility();
            return;
        }
        const hasFocusedParticipant = Boolean(this.focusedParticipantId && this.participantViews.has(this.focusedParticipantId));
        if (!hasFocusedParticipant) {
            this.focusedParticipantId = '';
            for (const view of this.participantViews.values()) {
                view.isFocused = false;
                view.isMini = false;
                if (view.element.parentElement !== this.videoGridAll) {
                    this.videoGridAll.appendChild(view.element);
                }
                this.applyParticipantViewState(view);
            }
            this.syncVideoGridVisibility();
            return;
        }

        for (const view of this.participantViews.values()) {
            const isFocused = view.id === this.focusedParticipantId;
            view.isFocused = isFocused;
            view.isMini = !isFocused;
            if (view.element.parentElement !== this.videoGridAll) {
                this.videoGridAll.appendChild(view.element);
            }
            this.applyParticipantViewState(view);
        }
        this.syncVideoGridVisibility();
    }

    setFocusedParticipant(participantId) {
        const id = String(participantId || '').trim();
        if (!id || !this.participantViews.has(id)) return;
        this.focusedParticipantId = id;
        this.renderParticipantLayout();
    }

    focusParticipantCard(target) {
        const participantId = String(target?.dataset?.participantId || '').trim();
        if (!participantId) return;
        if (this.focusedParticipantId === participantId) {
            this.focusedParticipantId = '';
            this.renderParticipantLayout();
            return;
        }
        this.setFocusedParticipant(participantId);
    }

    setParticipantMicState(participantId, isMicOn) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        view.micOn = Boolean(isMicOn);
        this.applyParticipantViewState(view);
    }

    attachVideoTrack(participantId, trackSid, mediaElement) {
        const id = String(participantId || '').trim();
        if (!id || !trackSid || !mediaElement) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        view.videoElement = mediaElement;
        if (view.element.parentElement !== this.videoGridAll && this.videoGridAll) {
            this.videoGridAll.appendChild(view.element);
        }

        const tryAttach = () => {
            const presenter = view.element.webSkelPresenter;
            if (presenter && typeof presenter.setVideoElement === 'function') {
                presenter.setVideoElement(mediaElement);
            } else {
                const host = view.element.querySelector('[data-role="mediaHost"]');
                if (host && !host.contains(mediaElement)) {
                    host.appendChild(mediaElement);
                }
            }
            const host = view.element.querySelector('[data-role="mediaHost"]');
            const attached = Boolean(host && host.contains(mediaElement));
            view.hasVideo = attached;
            this.applyParticipantViewState(view);
            return attached;
        };

        if (!tryAttach()) {
            let attempts = 0;
            const retryAttach = () => {
                attempts += 1;
                if (tryAttach() || attempts >= 12) {
                    return;
                }
                requestAnimationFrame(retryAttach);
            };
            requestAnimationFrame(retryAttach);
        }

        this.trackElements.set(trackSid, {
            participantId: id,
            kind: 'video',
            element: mediaElement
        });
        this.renderParticipantLayout();
    }

    clearVideoTrack(trackSid) {
        const track = this.trackElements.get(trackSid);
        if (!track || track.kind !== 'video') return;
        const view = this.participantViews.get(track.participantId);
        if (view) {
            const presenter = view.element.webSkelPresenter;
            if (presenter && typeof presenter.clearVideoElement === 'function') {
                presenter.clearVideoElement();
            } else {
                const host = view.element.querySelector('[data-role="mediaHost"]');
                const video = host?.querySelector('video');
                if (video) {
                    try { video.srcObject = null; } catch (_) {}
                    video.remove();
                }
            }
            view.hasVideo = false;
            view.videoElement = null;
            this.applyParticipantViewState(view);
        }
        try { track.element.srcObject = null; } catch (_) {}
        track.element.remove();
        this.trackElements.delete(trackSid);
    }

    attachAudioTrack(participantId, trackSid, mediaElement) {
        const id = String(participantId || '').trim();
        if (!id || !trackSid || !mediaElement) return;
        mediaElement.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
        const view = this.participantViews.get(id);
        if (view?.element && !view.element.contains(mediaElement)) {
            view.element.appendChild(mediaElement);
        }
        this.trackElements.set(trackSid, {
            participantId: id,
            kind: 'audio',
            element: mediaElement
        });
    }

    removeTrack(trackSid) {
        const entry = this.trackElements.get(trackSid);
        if (!entry) return;
        if (entry.kind === 'video') {
            this.clearVideoTrack(trackSid);
            return;
        }
        try { entry.element.srcObject = null; } catch (_) {}
        entry.element.remove();
        this.trackElements.delete(trackSid);
    }

    removeParticipantView(participantId) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        for (const [trackSid, track] of this.trackElements.entries()) {
            if (track.participantId === id) {
                this.removeTrack(trackSid);
            }
        }
        view.element.remove();
        this.participantViews.delete(id);
        if (this.focusedParticipantId === id) {
            this.focusedParticipantId = this.participantViews.keys().next().value || '';
        }
        this.renderParticipantLayout();
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

        for (const participantId of Array.from(this.participantViews.keys())) {
            if (!keep.has(participantId)) {
                this.removeParticipantView(participantId);
            }
        }

        this.state.participants = items;
        if (this.selectedMeeting?.id) {
            this.state.meetingParticipantsById[this.selectedMeeting.id] = items.map((entry) => ({
                id: entry.identity,
                name: entry.name
            })).filter((entry) => entry.id);
            this.renderMeetingList();
        }
        this.renderParticipantLayout();
        this.syncLocalMediaStateFromRoom(Track);
        this.renderFeedLists();
    }

    getLocalMediaStateFromRoom(TrackRef = null) {
        const Track = TrackRef || window.LivekitClient?.Track;
        const localParticipant = this.room?.localParticipant;
        const next = {
            microphone: false,
            camera: false,
            screen: false
        };
        if (!Track || !localParticipant?.trackPublications?.values) {
            return next;
        }
        next.microphone = this.isLocalSourceEnabled('microphone', Track);
        next.camera = this.isLocalSourceEnabled('camera', Track);
        next.screen = this.isLocalSourceEnabled('screen', Track);
        return next;
    }

    isLocalSourceEnabled(type, TrackRef = null) {
        const Track = TrackRef || window.LivekitClient?.Track;
        const localParticipant = this.room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) {
            return false;
        }
        const sourceMap = {
            microphone: Track.Source?.Microphone,
            camera: Track.Source?.Camera,
            screen: Track.Source?.ScreenShare
        };
        const wantedSource = sourceMap[type];
        const wantedKind = type === 'microphone' ? Track.Kind.Audio : Track.Kind.Video;

        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const sameKind = publication.kind === wantedKind;
            const sameSource = wantedSource ? publication.source === wantedSource : false;
            if ((sameSource || (type === 'camera' && sameKind && !publication.source))
                && !publication.isMuted) {
                return true;
            }
        }
        return false;
    }

    async waitForLocalSourceState(type, enabled, timeoutMs = 1200) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const current = this.isLocalSourceEnabled(type);
            if (current === enabled) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return false;
    }

    syncLocalMediaStateFromRoom(TrackRef = null) {
        const next = this.getLocalMediaStateFromRoom(TrackRef);
        this.state.media = next;
        const localId = String(this.room?.localParticipant?.identity || '').trim();
        if (localId) {
            this.setParticipantMicState(localId, next.microphone);
        }
    }

    async runExclusiveMediaToggle(action) {
        if (this.mediaToggleInFlight) {
            return;
        }
        this.mediaToggleInFlight = true;
        try {
            await action();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : String(error));
        } finally {
            this.syncLocalMediaStateFromRoom();
            this.renderMeetingSummary();
            this.mediaToggleInFlight = false;
        }
    }

    afterUnload() {
        this.element.removeEventListener('click', this.handleClick);
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
        const payload = await runTool('webmeet_meeting_list', { workspaceId: this.state.selectedWorkspaceId });
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
                name: String(entry?.displayName || entry?.id || 'Participant').trim() || 'Participant'
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
        this.meetingList.innerHTML = this.state.meetings.map((entry) => `
            <div class="webmeet-list-item ${entry.id === this.state.selectedMeetingId ? 'is-selected' : ''}" data-local-action="selectAndJoinMeeting" data-id="${escapeHtml(entry.id)}">
                <div class="webmeet-meeting-row">
                    <span class="webmeet-room-icon" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="6" width="14" height="12" rx="2" ry="2"></rect>
                            <polygon points="17 10 22 7 22 17 17 14"></polygon>
                        </svg>
                    </span>
                    <strong class="webmeet-meeting-title">${escapeHtml(entry.title)}</strong>
                    <span class="webmeet-meeting-status ${entry.id === this.state.selectedMeetingId ? '' : 'webmeet-hidden'}">${escapeHtml(entry.status)}</span>
                </div>
                ${this.renderMeetingParticipants(entry.id)}
            </div>
        `).join('') || '<div class="webmeet-feed-item">No meetings yet.</div>';
    }

    renderMeetingParticipants(meetingId) {
        const participants = Array.isArray(this.state.meetingParticipantsById?.[meetingId])
            ? this.state.meetingParticipantsById[meetingId]
            : [];
        if (!participants.length) {
            return '';
        }
        return `
            <div class="webmeet-room-participants">
                ${participants.map((participant, index) => `
                    <div class="webmeet-room-participant ${index === participants.length - 1 ? 'is-last' : ''}">
                        <span class="webmeet-room-participant-name"> - ${escapeHtml(participant.name || 'Participant')}</span>
                    </div>
                `).join('')}
            </div>
        `;
    }

    removeParticipantFromMeetingList(meetingId, participantId) {
        const targetMeetingId = String(meetingId || '').trim();
        const targetParticipantId = String(participantId || '').trim();
        if (!targetMeetingId || !targetParticipantId) return;
        const current = Array.isArray(this.state.meetingParticipantsById?.[targetMeetingId])
            ? this.state.meetingParticipantsById[targetMeetingId]
            : [];
        this.state.meetingParticipantsById[targetMeetingId] = current.filter((entry) => (
            String(entry?.id || '').trim() !== targetParticipantId
        ));
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
            this.removeParticipantFromMeetingList(currentMeetingId, this.state.session?.participantIdentity);
            const preservedName = String(this.state.session?.participant?.displayName || '').trim();
            this.stopSpeechRecognition();
            await this.disconnectRoom();
            this.state.session = preservedName ? { participant: { displayName: preservedName } } : null;
        }

        this.state.selectedMeetingId = nextMeetingId;
        await this.loadMeetingDetails();
        this.renderAll();
        const defaultName = String(this.state.session?.participant?.displayName || '').trim();
        await this.joinMeeting({ skipDisplayNamePrompt: Boolean(defaultName), displayNameOverride: defaultName });
    }

    async createMeeting() {
        if (!this.state.selectedWorkspaceId) {
            this.setError('Current Explorer workspace is unavailable.');
            return;
        }
        const title = window.prompt('Meeting title', 'Standup');
        if (!title) return;
        const meeting = await runTool('webmeet_meeting_create', { workspaceId: this.state.selectedWorkspaceId, title });
        this.state.selectedMeetingId = meeting?.id || this.state.selectedMeetingId;
        await this.loadMeetings();
        this.renderAll();
    }

    async joinMeeting(options = {}) {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        const skipPrompt = Boolean(options.skipDisplayNamePrompt);
        let displayName = String(options.displayNameOverride || '').trim();
        if (!skipPrompt) {
            displayName = String(window.prompt('Display name', displayName || 'Admin') || '').trim();
        }
        if (!displayName) return;
        this.state.session = await runTool('webmeet_meeting_join', { meetingId: meeting.id, displayName });
        await this.connectRoom();
        this.renderMeetingSummary();
    }

    async connectRoom() {
        if (!this.state.session?.participantToken || !this.state.session?.livekitUrl) {
            this.state.roomState = 'Join payload missing media token';
            this.renderMeetingSummary();
            return;
        }
        await this.disconnectRoom();
        const livekit = await ensureLiveKitClient();
        const { Room, RoomEvent, Track, DataPacket_Kind } = livekit;
        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = installRtcPeerConnectionOverride(this.state.session);
        const room = new Room({
            adaptiveStream: true,
            dynacast: true,
            rtcConfig: buildRtcConfigForSession(this.state.session)
        });
        this.room = room;
        this.state.roomState = 'Connecting';
        this.renderMeetingSummary();

        const renderPublication = (participant, publication, explicitTrack = null) => {
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
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                if (participantId === this.room?.localParticipant?.identity) {
                    mediaElement.muted = true;
                }
                this.attachAudioTrack(participantId, trackId, mediaElement);
                this.setParticipantMicState(participantId, !publication.isMuted);
            }
        };

        const removePublication = (publication) => {
            const trackId = String(publication?.trackSid || '').trim();
            if (!trackId) return;
            const trackInfo = this.trackElements.get(trackId);
            this.removeTrack(trackId);
            if (trackInfo?.kind === 'audio' || publication.kind === Track.Kind.Audio) {
                const participantId = String(trackInfo?.participantId || '').trim();
                if (participantId) {
                    const participant = participantId === this.room?.localParticipant?.identity
                        ? this.room.localParticipant
                        : this.room?.remoteParticipants?.get?.(participantId);
                    this.setParticipantMicState(participantId, this.isParticipantMicOn(participant, Track));
                }
            }
        };

        room
            .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                renderPublication(participant, publication, track);
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
                removePublication(publication);
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.LocalTrackPublished, (publication) => {
                renderPublication(room.localParticipant, publication);
                this.syncLocalMediaStateFromRoom(Track);
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.LocalTrackUnpublished, (publication) => {
                removePublication(publication);
                this.syncLocalMediaStateFromRoom(Track);
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.ParticipantConnected, () => {
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.ParticipantDisconnected, (participant) => {
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication);
                }
                this.removeParticipantView(participant.identity);
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.TrackMuted, (publication, participant) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    removePublication(publication);
                } else {
                    this.setParticipantMicState(participantId, false);
                }
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                }
            })
            .on(RoomEvent.TrackUnmuted, (publication, participant) => {
                const participantId = String(participant?.identity || '').trim();
                if (!participantId) return;
                const isVideoTrack = publication?.kind === Track.Kind.Video;
                if (isVideoTrack) {
                    renderPublication(participant, publication, publication?.track || null);
                }
                const sourceParticipant = participantId === this.room?.localParticipant?.identity
                    ? this.room.localParticipant
                    : this.room?.remoteParticipants?.get?.(participantId) || participant;
                this.setParticipantMicState(participantId, this.isParticipantMicOn(sourceParticipant, Track));
                if (participantId === String(this.room?.localParticipant?.identity || '').trim()) {
                    this.syncLocalMediaStateFromRoom(Track);
                }
                this.syncParticipantsFromRoom(this.room, Track);
            })
            .on(RoomEvent.DataReceived, (payload, participant) => {
                console.log('[WebMeet] DataReceived event fired, participant:', participant?.identity);
                try {
                    const text = new TextDecoder().decode(payload);
                    console.log('[WebMeet] DataReceived payload:', text.substring(0, 200));
                    const data = JSON.parse(text);
                    console.log('[WebMeet] DataReceived parsed:', data);
                    if (data.type === 'chat' && data.meetingId === this.selectedMeeting?.id) {
                        // Add to state.chat (same property used by renderFeedLists)
                        if (!this.state.chat) this.state.chat = [];
                        this.state.chat.push(data.message);
                        console.log('[WebMeet] Added message to state.chat, count:', this.state.chat.length);
                        this.renderFeedLists();
                    }
                } catch (err) {
                    console.error('[WebMeet] DataReceived error:', err);
                }
            })
            .on(RoomEvent.Disconnected, () => {
                this.restoreRtcPeerConnection?.();
                this.restoreRtcPeerConnection = null;
                this.room = null;
                this.mediaToggleInFlight = false;
                this.state.roomState = 'Disconnected';
                this.state.media = { microphone: false, camera: false, screen: false };
                this.state.participants = [];
                this.state.videoGridFullscreen = false;
                for (const track of this.trackElements.values()) {
                    try { track.element.srcObject = null; } catch (_) {}
                    track.element.remove();
                }
                for (const view of this.participantViews.values()) {
                    view.element.remove();
                }
                this.participantViews.clear();
                this.focusedParticipantId = '';
                this.trackElements.clear();
                this.setVideoGridEmptyState('Join a meeting to attach media tracks.');
                this.syncVideoGridVisibility();
                this.renderAll();
            });

        try {
            await room.connect(this.state.session.livekitUrl, this.state.session.participantToken);
            this.state.roomState = 'Connected';
            this.syncParticipantsFromRoom(this.room, Track);
            this.renderMeetingSummary();
        } catch (error) {
            this.state.roomState = error instanceof Error ? error.message : String(error);
            this.renderMeetingSummary();
            throw error;
        }
    }

    async disconnectRoom() {
        if (!this.room) return;
        try {
            await this.room.disconnect();
        } catch (_) {
            // ignore disconnect failures
        }
        this.restoreRtcPeerConnection?.();
        this.restoreRtcPeerConnection = null;
        this.room = null;
        this.mediaToggleInFlight = false;
        this.state.roomState = 'Disconnected';
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
        this.state.videoGridFullscreen = false;
        for (const track of this.trackElements.values()) {
            try { track.element.srcObject = null; } catch (_) {}
            track.element.remove();
        }
        for (const view of this.participantViews.values()) {
            const presenter = view.element.webSkelPresenter;
            if (presenter && typeof presenter.clearVideoElement === 'function') {
                presenter.clearVideoElement();
            }
            view.element.remove();
        }
        this.trackElements.clear();
        this.participantViews.clear();
        this.focusedParticipantId = '';
        this.setVideoGridEmptyState('Join a meeting to attach media tracks.');
        this.syncVideoGridVisibility();
        this.applyVideoGridFullscreenMode();
        this.renderAll();
    }

    async toggleMicrophone() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before enabling the microphone.');
            return;
        }
        await this.runExclusiveMediaToggle(async () => {
            const enable = !this.isLocalSourceEnabled('microphone');
            await this.room.localParticipant.setMicrophoneEnabled(enable);
            await this.waitForLocalSourceState('microphone', enable);
        });
    }

    async toggleCamera() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before enabling the camera.');
            return;
        }
        await this.runExclusiveMediaToggle(async () => {
            const localParticipant = this.room.localParticipant;
            const shouldEnableCamera = !this.isLocalSourceEnabled('camera');
            if (shouldEnableCamera && this.isLocalSourceEnabled('screen')) {
                await localParticipant.setScreenShareEnabled(false);
                await this.waitForLocalSourceState('screen', false);
            }
            await localParticipant.setCameraEnabled(shouldEnableCamera);
            await this.waitForLocalSourceState('camera', shouldEnableCamera);
        });
    }

    async toggleScreenShare() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before starting screen share.');
            return;
        }
        await this.runExclusiveMediaToggle(async () => {
            const localParticipant = this.room.localParticipant;
            const shouldEnableScreen = !this.isLocalSourceEnabled('screen');
            if (shouldEnableScreen && this.isLocalSourceEnabled('camera')) {
                await localParticipant.setCameraEnabled(false);
                await this.waitForLocalSourceState('camera', false);
            }
            await localParticipant.setScreenShareEnabled(shouldEnableScreen);
            await this.waitForLocalSourceState('screen', shouldEnableScreen);
        });
    }

    async leaveMeeting() {
        const previousMeetingId = String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
        const previousParticipantId = String(this.state.session?.participantIdentity || '').trim();
        this.removeParticipantFromMeetingList(previousMeetingId, previousParticipantId);
        this.stopSpeechRecognition();
        await this.disconnectRoom();
        this.state.session = null;
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
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting before closing it.');
            return;
        }
        await runTool('webmeet_close_meeting', { meetingId: meeting.id });
        await this.loadMeetings();
        this.renderAll();
    }

    closeModal(target) {
        const dialog = this.getDialogElement();
        if (dialog) {
            dialog.classList.remove('is-fullscreen');
        }
        assistOS.UI.closeModal(target || this.element);
    }
}
