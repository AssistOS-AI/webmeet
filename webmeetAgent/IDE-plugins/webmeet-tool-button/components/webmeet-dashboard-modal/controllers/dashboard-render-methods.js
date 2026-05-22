import { escapeHtml, formatDate } from '../services/dashboard-utils.js';
import { renderMessageWithMentionHighlights } from '../services/chat-autocomplete/index.js';
import {
    buildWebMeetAvatarSource,
    renderWebMeetAvatarPreview,
    WEBMEET_AVATAR_PRESETS
} from '../services/webmeet-avatar-override.js';
import { ensureAxiFaceLoaded } from '../services/webmeet-profile-avatar-runtime.js';

const AVATAR_OPTIONS = Object.freeze({
    assetMode: ['img', 'inline'],
    emotion: ['neutral', 'idle', 'listening', 'thinking', 'speaking', 'happy', 'amused', 'confused', 'concerned', 'alert', 'sleepy'],
    thoughtMode: ['none', 'bubble', 'caption', 'ticker', 'inside'],
    mode: ['static', 'controlled', 'event-driven', 'autonomous'],
    shape: ['circle', 'square', 'rounded', 'none'],
    theme: ['auto', 'light', 'dark'],
    style: ['robot-soft', 'robot-minimal', 'sketch', 'emoji', 'terminal'],
    palette: ['default', 'warm', 'mono', 'terminal', 'emoji'],
    complexity: ['', 'low', 'medium', 'high']
});

function renderOptionList(values = [], labels = {}) {
    return values.map((value) => {
        const raw = String(value || '').trim();
        const label = labels[raw] || raw || 'Default';
        return `<option value="${escapeHtml(raw)}">${escapeHtml(label)}</option>`;
    }).join('');
}

export const dashboardRenderMethods = {
    setRoomTransitionMessage(message, { render = true } = {}) {
        const text = String(message || '').trim();
        this.state.roomTransition = {
            active: Boolean(text),
            message: text
        };
        if (render) {
            this.renderMeetingSummary();
        }
    },

    clearRoomTransitionMessage({ render = true } = {}) {
        this.state.roomTransition = {
            active: false,
            message: ''
        };
        if (render) {
            this.renderMeetingSummary();
        }
    },

    buildRoomTransitionMessage(mode, roomName = '') {
        const title = String(roomName || '').trim() || 'room';
        if (mode === 'disconnecting') {
            return `Disconnecting from ${title}...`;
        }
        return `Connecting to ${title}...`;
    },

    setConnectingRoomTransition(roomName = '', options = {}) {
        this.setRoomTransitionMessage(this.buildRoomTransitionMessage('connecting', roomName), options);
    },

    setDisconnectingRoomTransition(roomName = '', options = {}) {
        this.setRoomTransitionMessage(this.buildRoomTransitionMessage('disconnecting', roomName), options);
    },

    getMeetingTitleById(meetingId, fallback = '') {
        const targetMeetingId = String(meetingId || '').trim();
        if (!targetMeetingId) {
            return String(fallback || '').trim();
        }
        const meeting = (this.state.meetings || []).find((entry) => String(entry?.id || '').trim() === targetMeetingId);
        return String(meeting?.title || fallback || '').trim();
    },

    renderAll() {
        const canManageRooms = this.canManageRooms();
        if (this.createRoomButton) {
            this.createRoomButton.classList.toggle('webmeet-hidden', !canManageRooms);
        }
        this.renderWorkspaceList();
        this.renderMeetingList();
        this.renderMeetingSummary();
        this.renderFeedLists();
        this.renderAvatarControls?.();
    },

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
    },

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
    },

    renderMeetingList() {
        this.meetingListController.render(
            this.state.meetings,
            this.state.selectedMeetingId,
            this.state.meetingParticipantsById,
            this.canManageRooms(),
            this.state.joiningMeetingId
        );
    },

    renderAvatarControls() {
        const currentOverride = this.loadCurrentWebMeetAvatarOverride?.() || null;
        this.state.webMeetAvatarOverride = currentOverride;
        if (this.state.webMeetAvatarOverrideDraft === null && currentOverride) {
            this.state.webMeetAvatarOverrideDraft = currentOverride;
        }
        const draft = this.state.webMeetAvatarOverrideDraft === undefined
            ? currentOverride
            : this.state.webMeetAvatarOverrideDraft;
        const options = [
            '<option value="">Custom state</option>',
            ...WEBMEET_AVATAR_PRESETS.map((preset) => (
                `<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</option>`
            ))
        ].join('');
        if (this.avatarPresetSelect) {
            if (this.avatarPresetSelect.innerHTML !== options) {
                this.avatarPresetSelect.innerHTML = options;
            }
            this.avatarPresetSelect.value = '';
        }
        const config = draft?.config || currentOverride?.config || this.state.session?.participant?.profileAvatar?.config || {};
        const syncSelect = (element, values, value, labels = {}) => {
            if (!element) return;
            const options = renderOptionList(values, labels);
            if (element.innerHTML !== options) element.innerHTML = options;
            element.value = String(value ?? '');
        };
        if (this.avatarGeneratedInput && document.activeElement !== this.avatarGeneratedInput) {
            this.avatarGeneratedInput.checked = config.generated !== false;
        }
        if (this.avatarAnimatedInput && document.activeElement !== this.avatarAnimatedInput) {
            this.avatarAnimatedInput.checked = config.animated !== false;
        }
        if (this.avatarListenInput && document.activeElement !== this.avatarListenInput) {
            this.avatarListenInput.checked = config.listen === true;
        }
        const textInputs = [
            [this.avatarSrcInput, config.src || ''],
            [this.avatarPackSrcInput, config.packSrc || ''],
            [this.avatarSizeInput, config.size || '72'],
            [this.avatarThoughtInput, config.thought || '']
        ];
        for (const [input, value] of textInputs) {
            if (input && document.activeElement !== input) input.value = String(value || '');
        }
        syncSelect(this.avatarAssetModeSelect, AVATAR_OPTIONS.assetMode, config.assetMode || 'img');
        syncSelect(this.avatarEmotionSelect, AVATAR_OPTIONS.emotion, config.emotion || 'neutral');
        syncSelect(this.avatarThoughtModeSelect, AVATAR_OPTIONS.thoughtMode, config.thoughtMode || 'none');
        syncSelect(this.avatarModeSelect, AVATAR_OPTIONS.mode, config.mode || 'static');
        syncSelect(this.avatarShapeSelect, AVATAR_OPTIONS.shape, config.shape || 'circle');
        syncSelect(this.avatarThemeSelect, AVATAR_OPTIONS.theme, config.theme || 'auto');
        syncSelect(this.avatarStyleSelect, AVATAR_OPTIONS.style, config.style || 'robot-soft');
        syncSelect(this.avatarPaletteSelect, AVATAR_OPTIONS.palette, config.palette || 'default');
        syncSelect(this.avatarComplexitySelect, AVATAR_OPTIONS.complexity, config.complexity || '', { '': 'Default' });
        if (this.avatarSourceLabel) {
            this.avatarSourceLabel.textContent = currentOverride
                ? 'WebMeet browser override'
                : 'Profile avatar';
        }
        if (this.avatarPreview) {
            const profileAvatar = this.state.session?.participant?.profileAvatar || null;
            const effectiveSource = buildWebMeetAvatarSource({
                profileAvatar,
                override: draft,
                userId: this.getCurrentAvatarOverrideUserId?.() || '',
                participantId: this.state.session?.participantIdentity || ''
            });
            this.avatarPreview.innerHTML = effectiveSource?.config
                ? renderWebMeetAvatarPreview(effectiveSource.config)
                : '<span class="webmeet-avatar-preview-letter">?</span>';
            if (effectiveSource?.config && typeof customElements !== 'undefined' && !customElements.get('axi-face')) {
                this.avatarPreviewLoadPromise ||= ensureAxiFaceLoaded()
                    .then(() => {
                        this.avatarPreviewLoadPromise = null;
                        this.renderAvatarControls?.();
                    })
                    .catch(() => {
                        this.avatarPreviewLoadPromise = null;
                    });
            }
        }
        if (this.avatarQuickButton) {
            this.avatarQuickButton.classList.toggle('active', Boolean(currentOverride));
            this.avatarQuickButton.setAttribute('aria-expanded', this.state.avatarQuickMenuVisible ? 'true' : 'false');
            this.avatarQuickButton.title = currentOverride
                ? 'Avatar: WebMeet override'
                : 'Avatar state';
        }
        if (this.avatarQuickMenu) {
            this.avatarQuickMenu.classList.toggle('webmeet-hidden', !this.state.avatarQuickMenuVisible);
            this.avatarQuickMenu.innerHTML = [
                '<button type="button" class="webmeet-avatar-preset-item" data-local-action="resetWebMeetAvatarOverride">Profile avatar</button>',
                ...WEBMEET_AVATAR_PRESETS.map((preset) => (
                    `<button type="button" class="webmeet-avatar-preset-item" data-local-action="applyWebMeetAvatarPreset" data-avatar-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</button>`
                ))
            ].join('');
        }
    },

    renderMeetingSummary() {
        const canManageRooms = this.canManageRooms();
        const meeting = this.selectedMeeting;
        const isJoined = !!this.state.session?.participantIdentity;
        const isLeaving = Boolean(this.state.leavingMeeting);
        const roomTransition = this.state.roomTransition || {};
        const isTransitioningRoom = Boolean(roomTransition.active);
        const roomTransitionMessage = String(roomTransition.message || '').trim();

        if (this.dashboardModalRoot) {
            this.dashboardModalRoot.classList.toggle('is-joined', isJoined);
            this.dashboardModalRoot.classList.toggle('is-leaving-room', isLeaving);
            this.dashboardModalRoot.classList.toggle('is-room-transitioning', isTransitioningRoom);
            this.dashboardModalRoot.setAttribute('aria-busy', isTransitioningRoom ? 'true' : 'false');
        }
        this.renderAvatarControls?.();
        if (this.exitOverlay) {
            this.exitOverlay.classList.toggle('webmeet-hidden', !isTransitioningRoom);
        }
        if (this.roomTransitionMessage) {
            this.roomTransitionMessage.textContent = roomTransitionMessage || 'Connecting to room...';
        }
        
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
        if (!isJoined && this.state.videoGridFullscreen) {
            this.state.videoGridFullscreen = false;
        }
        this.applyChatSidebarVisibility();
        this.applyVideoGridFullscreenMode();
        this.applyMobilePanelState();
        
        this.meetingTitle.textContent = meeting?.title || 'None';
        this.meetingMeta.textContent = meeting ? formatDate(meeting.createdAt) : '';
        
        // Update active room title in header
        if (this.activeRoomTitle) {
            this.activeRoomTitle.textContent = meeting?.title || 'Select a room';
        }
        this.lifecycle.textContent = meeting?.status || 'Idle';
        this.joinStatus.textContent = isJoined ? 'Joined' : 'Not joined';
        this.joinPayload.value = this.state.session ? JSON.stringify(this.state.session, null, 2) : '';
        this.roomConnectionState.textContent = `${this.state.roomState} · transcript ${this.state.transcriptState}`;

        // Update recording button
        const latestRecording = [...(Array.isArray(this.state.recordings) ? this.state.recordings : [])].reverse()[0] || null;
        if (this.recordingButton) {
            this.recordingButton.classList.toggle('webmeet-hidden', !canManageRooms);
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
        if (this.deafenButton) {
            const isDeafened = Boolean(this.state.mediaDeafened);
            this.deafenButton.classList.toggle('active', isDeafened);
            this.deafenButton.title = isDeafened ? 'Undeafen' : 'Deafen';
            this.deafenButton.setAttribute('aria-label', isDeafened ? 'Undeafen' : 'Deafen');
        }
        if (this.cameraButton) {
            this.cameraButton.classList.toggle('active', this.state.media.camera);
        }
        if (this.screenShareButton) {
            this.screenShareButton.classList.toggle('active', this.state.media.screen);
        }
        const mediaBusy = Object.values(this.state.mediaLoading || {}).some(Boolean) || isLeaving || isTransitioningRoom;
        const setMediaButtonLoading = (button, type) => {
            if (!button) return;
            const isLoading = Boolean(this.state.mediaLoading?.[type]);
            button.classList.toggle('is-loading', isLoading);
            button.disabled = mediaBusy;
            button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        };
        setMediaButtonLoading(this.micButton, 'microphone');
        if (this.deafenButton) {
            this.deafenButton.disabled = mediaBusy;
            this.deafenButton.setAttribute('aria-busy', 'false');
        }
        setMediaButtonLoading(this.cameraButton, 'camera');
        setMediaButtonLoading(this.screenShareButton, 'screen');
        if (this.leaveButton) {
            this.leaveButton.classList.toggle('is-loading', isLeaving);
            this.leaveButton.disabled = isLeaving || isTransitioningRoom;
            this.leaveButton.setAttribute('aria-busy', (isLeaving || isTransitioningRoom) ? 'true' : 'false');
        }
        if (this.mediaSettingsButton) {
            this.mediaSettingsButton.disabled = isLeaving || isTransitioningRoom;
        }
        if (this.recordingButton) {
            this.recordingButton.disabled = isLeaving || isTransitioningRoom;
        }
    },

    renderFeedLists() {
        const renderFeed = (target, entries, formatter, shouldScroll = false, emptyHtml = '<div class="webmeet-feed-item">No data yet.</div>') => {
            if (!target) return;
            const safeEntries = Array.isArray(entries) ? entries : [];
            target.innerHTML = safeEntries.map(formatter).join('') || emptyHtml;
            if (shouldScroll) {
                target.scrollTop = target.scrollHeight;
            }
        };

        const knownAgentTokens = this.chatComponent?.getKnownAgentTokens?.() || [];
        const chatMessageHtml = (message) => renderMessageWithMentionHighlights(message || '', knownAgentTokens);
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
                        <div class="webmeet-chat-text">${chatMessageHtml(entry.message)}</div>
                    </div>
                </div>
            </div>
        `, true, '<div class="webmeet-chat-empty">No messages yet. Start the conversation.</div>');

        renderFeed(this.transcriptListSidebar, this.state.transcript, (entry) => `
            <div class="webmeet-feed-item">
                <div class="webmeet-chat-meta">
                    <strong class="webmeet-chat-author">${escapeHtml(entry.speakerName || entry.speakerId || 'unknown')}</strong>
                    <span class="webmeet-chat-time">${escapeHtml(formatDate(entry.startedAt || entry.createdAt))}</span>
                </div>
                <div class="webmeet-chat-text">${escapeHtml(entry.text || '')}</div>
            </div>
        `, true, '<div class="webmeet-chat-empty">No transcript yet.</div>');

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
    }

};
