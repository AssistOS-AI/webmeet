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
            channels: [],
            meetings: [],
            chat: [],
            transcript: [],
            artifacts: [],
            recordings: [],
            tasks: [],
            decisions: [],
            agents: [],
            selectedWorkspaceId: '',
            selectedChannelId: '',
            selectedMeetingId: '',
            session: null,
            roomState: 'Disconnected',
            transcriptState: 'Idle',
            media: {
                microphone: false,
                camera: false,
                screen: false
            },
            participants: []
        };
        this.room = null;
        this.restoreRtcPeerConnection = null;
        this.speechRecognition = null;
        this.trackElements = new Map();
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
                'createChannel',
                'createMeeting',
                'joinMeeting',
                'leaveMeeting',
                'toggleRecording',
                'toggleMicrophone',
                'toggleCamera',
                'toggleScreenShare',
                'sendChat',
                'appendTranscript',
                'startAutoTranscript',
                'stopAutoTranscript',
                'selectChannel',
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

            // Handle chat/live room tabs (now only live room in main area)
            if (tabId === 'live') {
                const liveTab = this.element.querySelector('#webmeetLiveTab');
                if (liveTab) {
                    liveTab.classList.remove('webmeet-hidden');
                }
            }

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

            // Handle participants panel collapse (vertical content)
            if (collapsibleId === 'participants') {
                const collapsibles = this.element.querySelectorAll(`[data-collapsible="${collapsibleId}"]`);
                const isCollapsed = collapseButton.classList.contains('collapsed');

                // Toggle collapsible elements
                collapsibles.forEach(el => {
                    el.classList.toggle('expanded', !isCollapsed);
                });

                return;
            }

            // Handle chat sidebar collapse (horizontal)
            if (collapsibleId === 'chat') {
                const chatSidebar = this.element.querySelector('#webmeetChatSidebar');
                if (chatSidebar) {
                    chatSidebar.classList.toggle('collapsed');
                }
                const collapsibles = this.element.querySelectorAll(`[data-collapsible="${collapsibleId}"]`);
                const isCollapsed = collapseButton.classList.contains('collapsed');
                collapsibles.forEach(el => {
                    el.classList.toggle('expanded', !isCollapsed);
                });
                return;
            }

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
        this.channelList = this.element.querySelector('#webmeetChannelList');
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
        this.participantsList = this.element.querySelector('#webmeetParticipantsList');
        this.recordingButton = this.element.querySelector('#webmeetRecordingButton');
        this.micButton = this.element.querySelector('#webmeetMicButton');
        this.cameraButton = this.element.querySelector('#webmeetCameraButton');
        this.screenShareButton = this.element.querySelector('#webmeetScreenShareButton');
        this.welcomeScreen = this.element.querySelector('#webmeetWelcomeScreen');
        this.meetingBar = this.element.querySelector('.webmeet-meeting-bar');
        this.mainContent = this.element.querySelector('.webmeet-main-content');
        this.secondaryPanels = this.element.querySelector('.webmeet-secondary-panels');
    }

    afterUnload() {
        this.element.removeEventListener('click', this.handleClick);
        void this.disconnectRoom();
    }

    async bootstrap() {
        try {
            await this.loadWorkspaces();
            this.state.selectedWorkspaceId = this.state.workspaces[0]?.id || '';
            await this.loadChannels();
            if (this.state.selectedChannelId) {
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

    async loadChannels() {
        if (!this.state.selectedWorkspaceId) {
            this.state.channels = [];
            this.state.selectedChannelId = '';
            return;
        }
        const payload = await runTool('webmeet_channel_list', { workspaceId: this.state.selectedWorkspaceId });
        this.state.channels = Array.isArray(payload.channels) ? payload.channels : [];
        this.state.selectedChannelId = this.state.channels.some((entry) => entry.id === this.state.selectedChannelId)
            ? this.state.selectedChannelId
            : (this.state.channels[0]?.id || '');
    }

    async loadMeetings() {
        if (!this.state.selectedChannelId) {
            this.state.meetings = [];
            this.state.selectedMeetingId = '';
            return;
        }
        const payload = await runTool('webmeet_meeting_list', { channelId: this.state.selectedChannelId });
        this.state.meetings = Array.isArray(payload.meetings) ? payload.meetings : [];
        this.state.selectedMeetingId = this.state.meetings.some((entry) => entry.id === this.state.selectedMeetingId)
            ? this.state.selectedMeetingId
            : (this.state.meetings[0]?.id || '');
        await this.loadMeetingDetails();
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
        this.renderChannelList();
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

    renderChannelList() {
        this.channelList.innerHTML = this.state.channels.map((entry) => `
            <div class="webmeet-list-item ${entry.id === this.state.selectedChannelId ? 'is-selected' : ''}" data-local-action="selectChannel" data-id="${escapeHtml(entry.id)}">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.name)}</strong>
                    <span class="webmeet-channel-status ${entry.id === this.state.selectedChannelId ? '' : 'webmeet-hidden'}">${escapeHtml(entry.kind)}</span>
                </div>
            </div>
        `).join('') || '<div class="webmeet-feed-item">No channels yet.</div>';
    }

    renderMeetingList() {
        this.meetingList.innerHTML = this.state.meetings.map((entry) => `
            <div class="webmeet-list-item ${entry.id === this.state.selectedMeetingId ? 'is-selected' : ''}" data-local-action="selectAndJoinMeeting" data-id="${escapeHtml(entry.id)}">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.title)}</strong>
                    <span class="webmeet-meeting-status ${entry.id === this.state.selectedMeetingId ? '' : 'webmeet-hidden'}">${escapeHtml(entry.status)}</span>
                </div>
            </div>
        `).join('') || '<div class="webmeet-feed-item">No meetings yet.</div>';
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
                this.recordingButton.textContent = 'Stop rec';
                this.recordingButton.classList.remove('subtle-button');
                this.recordingButton.classList.add('danger-button');
            } else {
                this.recordingButton.textContent = 'Start rec';
                this.recordingButton.classList.remove('danger-button');
                this.recordingButton.classList.add('subtle-button');
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
        const renderFeed = (target, entries, formatter, shouldScroll = false) => {
            target.innerHTML = entries.map(formatter).join('') || '<div class="webmeet-feed-item">No data yet.</div>';
            if (shouldScroll) {
                target.scrollTop = target.scrollHeight;
            }
        };

        renderFeed(this.chatList, this.state.chat, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.authorName || entry.authorId || 'unknown')}</strong>
                    <span>${escapeHtml(formatDate(entry.createdAt))}</span>
                </div>
                <div>${escapeHtml(entry.message || '')}</div>
            </div>
        `, true);

        renderFeed(this.participantsList, this.state.participants, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-list-item-header">
                    <strong>${escapeHtml(entry.name)}</strong>
                    <span>${escapeHtml(entry.kind)}</span>
                </div>
            </div>
        `);

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

    async selectChannel(element) {
        this.state.selectedChannelId = element.dataset.id || '';
        await this.loadMeetings();
        this.renderAll();
    }

    async selectMeeting(element) {
        this.state.selectedMeetingId = element.dataset.id || '';
        await this.loadMeetingDetails();
        this.renderAll();
    }

    async selectAndJoinMeeting(element) {
        this.state.selectedMeetingId = element.dataset.id || '';
        await this.loadMeetingDetails();
        this.renderAll();
        await this.joinMeeting();
    }

    async createChannel() {
        if (!this.state.selectedWorkspaceId) {
            this.setError('Current Explorer workspace is unavailable.');
            return;
        }
        const name = window.prompt('Channel name', 'general');
        if (!name) return;
        const channel = await runTool('webmeet_channel_create', { workspaceId: this.state.selectedWorkspaceId, name, kind: 'meeting' });
        this.state.selectedChannelId = channel?.id || this.state.selectedChannelId;
        await this.loadChannels();
        await this.loadMeetings();
        this.renderAll();
    }

    async createMeeting() {
        if (!this.state.selectedChannelId) {
            this.setError('Select or create a channel first.');
            return;
        }
        const title = window.prompt('Meeting title', 'Standup');
        if (!title) return;
        const meeting = await runTool('webmeet_meeting_create', { channelId: this.state.selectedChannelId, title });
        this.state.selectedMeetingId = meeting?.id || this.state.selectedMeetingId;
        await this.loadMeetings();
        this.renderAll();
    }

    async joinMeeting() {
        const meeting = this.selectedMeeting;
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        const displayName = window.prompt('Display name', 'Admin');
        if (!displayName) return;
        this.state.session = await runTool('webmeet_meeting_join', { meetingId: meeting.id, displayName });
        await this.connectRoom();
        this.renderMeetingSummary();

        // Expand Participants panel when joining
        const participantsCollapseButton = this.element.querySelector('[data-collapse="participants"]');
        if (participantsCollapseButton && participantsCollapseButton.classList.contains('collapsed')) {
            participantsCollapseButton.classList.remove('collapsed');
        }
        const participantsCollapsible = this.element.querySelector('[data-collapsible="participants"]');
        if (participantsCollapsible && !participantsCollapsible.classList.contains('expanded')) {
            participantsCollapsible.classList.add('expanded');
        }
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

        // Helper to get or create participant card
        const getOrCreateParticipantCard = (participant) => {
            const participantId = participant.identity || 'unknown';
            let card = this.videoGrid.querySelector(`[data-participant-id="${participantId}"]`);
            if (!card) {
                card = document.createElement('div');
                card.className = 'webmeet-participant-card';
                card.dataset.participantId = participantId;
                
                // Avatar with initials
                const name = participant.name || participant.identity || 'User';
                const initials = name.split(' ').map(n => n[0]).join('').substring(0, 2);
                
                card.innerHTML = `
                    <div class="webmeet-participant-info">
                        <div class="webmeet-participant-avatar">${escapeHtml(initials)}</div>
                        <div class="webmeet-participant-name">${escapeHtml(name)}</div>
                    </div>
                    <div class="webmeet-participant-status">
                        <span class="webmeet-status-icon mic-status muted" title="Microphone OFF">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <line x1="1" y1="1" x2="23" y2="23"></line>
                                <path d="M9 9v6a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.18"></path>
                                <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                                <line x1="12" y1="19" x2="12" y2="23"></line>
                                <line x1="8" y1="23" x2="16" y2="23"></line>
                            </svg>
                        </span>
                    </div>
                `;
                
                const emptyMsg = this.videoGrid.querySelector('.webmeet-video-empty');
                if (emptyMsg) emptyMsg.remove();
                this.videoGrid.appendChild(card);
            }
            return card;
        };

        const syncParticipants = () => {
            if (!this.room) return;
            const items = [{
                identity: this.room.localParticipant?.identity || this.state.session?.participantIdentity || '',
                name: this.room.localParticipant?.name || this.state.session?.participant?.displayName || 'You',
                kind: 'local'
            }];
            for (const participant of this.room.remoteParticipants.values()) {
                items.push({
                    identity: participant.identity || '',
                    name: participant.name || participant.identity || 'Remote',
                    kind: 'remote'
                });
            }
            this.state.participants = items;
            this.renderFeedLists();
        };

        const renderPublication = (participant, publication, labelPrefix = '') => {
            const track = publication?.track;
            if (!track) return;
            const trackId = publication.trackSid || `${participant.identity}:${publication.source || publication.kind}`;
            const card = getOrCreateParticipantCard(participant);
            
            if (track.kind === Track.Kind.Video) {
                // Video track - show video, hide avatar
                card.classList.add('has-video');
                let video = card.querySelector('video');
                if (video) {
                    video.remove();
                }
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                mediaElement.playsInline = true;
                card.insertBefore(mediaElement, card.firstChild);
                
                // Hide avatar info when video is active
                const info = card.querySelector('.webmeet-participant-info');
                if (info) info.style.display = 'none';
            } else if (track.kind === Track.Kind.Audio) {
                // Audio track - attach and insert into DOM (required for playback)
                const mediaElement = track.attach();
                mediaElement.autoplay = true;
                if (participant.identity === this.room?.localParticipant?.identity) {
                    mediaElement.muted = true;
                }
                mediaElement.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
                card.appendChild(mediaElement);
                this.trackElements.set(`${trackId}_audio`, mediaElement);
            }
            
            this.trackElements.set(trackId, card);
        };

        const removePublication = (publication) => {
            const trackId = publication?.trackSid;
            if (!trackId) return;
            
            // Remove audio element if exists
            const audioEl = this.trackElements.get(`${trackId}_audio`);
            if (audioEl) {
                audioEl.remove();
                this.trackElements.delete(`${trackId}_audio`);
            }
            
            const card = this.trackElements.get(trackId);
            if (!card) return;
            
            if (publication.kind === Track.Kind.Video) {
                // Remove video, show avatar again
                card.classList.remove('has-video');
                const video = card.querySelector('video');
                if (video) {
                    video.srcObject = null;
                    video.remove();
                }
                const info = card.querySelector('.webmeet-participant-info');
                if (info) info.style.display = '';
            }
            
            this.trackElements.delete(trackId);
            
            // Only remove card if no more tracks for this participant
            const participantId = card.dataset.participantId;
            const hasMoreTracks = [...this.trackElements.keys()].some(key => {
                const el = this.trackElements.get(key);
                return el && el.dataset && el.dataset.participantId === participantId;
            });
            if (!hasMoreTracks && !this.room?.remoteParticipants.has(participantId) && participantId !== this.room?.localParticipant?.identity) {
                card.remove();
            }
            
            if (!this.videoGrid.querySelector('.webmeet-participant-card')) {
                this.videoGrid.innerHTML = '<div class="webmeet-video-empty">Join a meeting to see participants.</div>';
            }
        };

        room
            .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
                renderPublication(participant, publication);
                syncParticipants();
            })
            .on(RoomEvent.TrackUnsubscribed, (_track, publication) => {
                removePublication(publication);
                syncParticipants();
            })
            .on(RoomEvent.LocalTrackPublished, (publication) => {
                renderPublication(room.localParticipant, publication, 'You · ');
            })
            .on(RoomEvent.LocalTrackUnpublished, (publication) => {
                removePublication(publication);
            })
            .on(RoomEvent.ParticipantConnected, () => {
                syncParticipants();
            })
            .on(RoomEvent.ParticipantDisconnected, (participant) => {
                for (const publication of participant.trackPublications.values()) {
                    removePublication(publication);
                }
                syncParticipants();
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
                this.state.roomState = 'Disconnected';
                this.state.media = { microphone: false, camera: false, screen: false };
                this.state.participants = [];
                this.trackElements.clear();
                this.videoGrid.innerHTML = '<div class="webmeet-video-empty">Join a meeting to attach media tracks.</div>';
                this.renderAll();
            });

        try {
            await room.connect(this.state.session.livekitUrl, this.state.session.participantToken);
            this.state.roomState = 'Connected';
            syncParticipants();
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
        this.state.roomState = 'Disconnected';
        this.state.media = { microphone: false, camera: false, screen: false };
        this.state.participants = [];
        for (const tile of this.trackElements.values()) {
            Array.from(tile.querySelectorAll('video,audio')).forEach((node) => {
                try { node.srcObject = null; } catch (_) {}
            });
        }
        this.trackElements.clear();
        if (this.videoGrid) {
            this.videoGrid.innerHTML = '<div class="webmeet-video-empty">Join a meeting to attach media tracks.</div>';
        }
        this.renderAll();
    }

    async toggleMicrophone() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before enabling the microphone.');
            return;
        }
        this.state.media.microphone = !this.state.media.microphone;
        await this.room.localParticipant.setMicrophoneEnabled(this.state.media.microphone);
        this.renderMeetingSummary();
    }

    async toggleCamera() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before enabling the camera.');
            return;
        }
        this.state.media.camera = !this.state.media.camera;
        await this.room.localParticipant.setCameraEnabled(this.state.media.camera);
        this.renderMeetingSummary();
    }

    async toggleScreenShare() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before starting screen share.');
            return;
        }
        this.state.media.screen = !this.state.media.screen;
        await this.room.localParticipant.setScreenShareEnabled(this.state.media.screen);
        this.renderMeetingSummary();
    }

    async leaveMeeting() {
        this.stopSpeechRecognition();
        await this.disconnectRoom();
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
        assistOS.UI.closeModal(target || this.element);
    }
}
