import { escapeHtml, formatDate } from '../services/dashboard-utils.js';
import { renderMessageWithMentionHighlights } from '../services/chat-autocomplete/index.js';
import {
    buildWebMeetAvatarSource,
    renderWebMeetAvatarPreview,
    WEBMEET_AVATAR_PRESETS
} from '../services/webmeet-avatar-override.js';
import {
    ensureAxiFaceLoaded,
    getLoadedAxiFaceGeneratedFaceStyles,
    loadAxiFaceGeneratedFacePalettes,
    loadAxiFaceGeneratedFaceStyles,
    loadAxiFacePacks
} from '../services/webmeet-profile-avatar-runtime.js';
import {
    AVATAR_SOURCE_MODES,
    deriveAvatarSourceMode,
    formatAvatarOptionLabel as formatSharedAvatarOptionLabel
} from '../services/avatar-settings-model.js';

function formatAvatarOptionLabel(value = '') {
    return formatSharedAvatarOptionLabel(value);
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
           // this.avatarPresetSelect.value = '';
        }
        const config = draft?.config || currentOverride?.config || this.state.session?.participant?.profileAvatar?.config || {};
        const loadedAxiFaceStyles = getLoadedAxiFaceGeneratedFaceStyles();
        const avatarStyles = loadedAxiFaceStyles.length > 0
            ? loadedAxiFaceStyles
            : (Array.isArray(this.state.axiFaceGeneratedFaceStyles) ? this.state.axiFaceGeneratedFaceStyles : []);
        if ((avatarStyles.length === 0 || this.state.axiFacePacks.length === 0) && !this.avatarMetadataLoadPromise) {
            this.avatarMetadataLoadPromise = Promise.all([
                loadAxiFaceGeneratedFaceStyles().catch(() => []),
                loadAxiFaceGeneratedFacePalettes().catch(() => []),
                loadAxiFacePacks().catch(() => [])
            ])
                .then(([styles, palettes, packs]) => {
                    this.state.axiFaceGeneratedFaceStyles = styles;
                    this.state.axiFaceGeneratedFacePalettes = palettes;
                    this.state.axiFacePacks = packs;
                    this.avatarMetadataLoadPromise = null;
                    this.renderAvatarControls?.();
                })
                .catch(() => {
                    this.avatarMetadataLoadPromise = null;
                });
        }
        if (this.avatarSettingsForm?.webSkelPresenter) {
            this.avatarSettingsForm.webSkelPresenter.setData({
                value: config,
                packs: this.state.axiFacePacks,
                generatedStyles: avatarStyles,
                palettes: this.state.axiFaceGeneratedFacePalettes,
                hiddenFields: ['seed'],
                showPreview: false
            });
        }
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
            const currentStyle = String(config.style || 'robot-soft').trim() || 'robot-soft';
            const currentSourceMode = deriveAvatarSourceMode(config);
            const currentPackSrc = String(config.packSrc || '').trim();
            let sourceOptionLabel = 'Style';
            let sourceOptionItems = avatarStyles.map((style) => {
                const activeClass = style === currentStyle ? ' is-active' : '';
                const label = formatAvatarOptionLabel(style);
                return `<button type="button" class="webmeet-avatar-preset-item${activeClass}" data-local-action="applyWebMeetAvatarStyle" data-avatar-style="${escapeHtml(style)}">${escapeHtml(label)}</button>`;
            });
            if (currentSourceMode === AVATAR_SOURCE_MODES.PACK) {
                sourceOptionLabel = 'AxiFace pack';
                sourceOptionItems = this.state.axiFacePacks.map((pack) => {
                    const manifestSrc = String(pack?.manifestSrc || '').trim();
                    const activeClass = manifestSrc && manifestSrc === currentPackSrc ? ' is-active' : '';
                    const label = String(pack?.label || pack?.id || '').trim() || 'Pack';
                    return `<button type="button" class="webmeet-avatar-preset-item${activeClass}" data-local-action="applyWebMeetAvatarPack" data-avatar-pack-src="${escapeHtml(manifestSrc)}">${escapeHtml(label)}</button>`;
                });
            } else if (currentSourceMode === AVATAR_SOURCE_MODES.SVG) {
                sourceOptionLabel = 'SVG source';
                sourceOptionItems = [
                    '<button type="button" class="webmeet-avatar-preset-item" disabled>Set the SVG source in settings</button>'
                ];
            }
            this.avatarQuickMenu.classList.toggle('webmeet-hidden', !this.state.avatarQuickMenuVisible);
            this.avatarQuickMenu.innerHTML = [
                ...WEBMEET_AVATAR_PRESETS.map((preset) => (
                    `<button type="button" class="webmeet-avatar-preset-item" data-local-action="applyWebMeetAvatarPreset" data-avatar-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}</button>`
                )),
                `<div class="webmeet-avatar-submenu">
                    <button type="button" class="webmeet-avatar-preset-item webmeet-avatar-submenu-trigger" aria-haspopup="true" aria-expanded="false">Avatar source</button>
                    <div class="webmeet-avatar-submenu-menu">
                        <button type="button" class="webmeet-avatar-preset-item${currentSourceMode === AVATAR_SOURCE_MODES.GENERATED ? ' is-active' : ''}" data-local-action="applyWebMeetAvatarSourceMode" data-avatar-source-mode="${AVATAR_SOURCE_MODES.GENERATED}">Generated</button>
                        <button type="button" class="webmeet-avatar-preset-item${currentSourceMode === AVATAR_SOURCE_MODES.PACK ? ' is-active' : ''}" data-local-action="applyWebMeetAvatarSourceMode" data-avatar-source-mode="${AVATAR_SOURCE_MODES.PACK}">AxiFace pack</button>
                        <button type="button" class="webmeet-avatar-preset-item${currentSourceMode === AVATAR_SOURCE_MODES.SVG ? ' is-active' : ''}" data-local-action="applyWebMeetAvatarSourceMode" data-avatar-source-mode="${AVATAR_SOURCE_MODES.SVG}">SVG source</button>
                    </div>
                </div>`,
                `<div class="webmeet-avatar-submenu">
                    <button type="button" class="webmeet-avatar-preset-item webmeet-avatar-submenu-trigger" aria-haspopup="true" aria-expanded="false">${escapeHtml(sourceOptionLabel)}</button>
                    <div class="webmeet-avatar-submenu-menu">
                        ${sourceOptionItems.join('')}
                    </div>
                </div>`
            ].join('');
        }
    },

    renderMeetingSummary() {
        const canManageRooms = this.canManageRooms();
        const meeting = this.selectedMeeting;
        const isJoined = !!this.state.session?.participantIdentity;
        const isArchivedMeeting = String(meeting?.status || '').trim().toLowerCase() === 'archived'
            || Boolean(String(meeting?.archivedAt || '').trim());
        const isArchiveReadOnlyView = Boolean(canManageRooms && meeting && isArchivedMeeting && !isJoined);
        const isLeaving = Boolean(this.state.leavingMeeting);
        const roomTransition = this.state.roomTransition || {};
        const isTransitioningRoom = Boolean(roomTransition.active);
        const roomTransitionMessage = String(roomTransition.message || '').trim();

        if (this.dashboardModalRoot) {
            this.dashboardModalRoot.classList.toggle('is-joined', isJoined);
            this.dashboardModalRoot.classList.toggle('is-leaving-room', isLeaving);
            this.dashboardModalRoot.classList.toggle('is-room-transitioning', isTransitioningRoom);
            this.dashboardModalRoot.classList.toggle('is-archive-readonly', isArchiveReadOnlyView);
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
            this.welcomeScreen.classList.toggle('webmeet-hidden', isJoined || isArchiveReadOnlyView);
        }
        if (this.meetingBar) {
            this.meetingBar.classList.toggle('webmeet-hidden', !isJoined && !isArchiveReadOnlyView);
        }
        if (this.mainContent) {
            this.mainContent.classList.toggle('webmeet-hidden', !isJoined && !isArchiveReadOnlyView);
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
        /*if (this.activeRoomTitle) {
            this.activeRoomTitle.textContent = meeting?.title || 'Select a room';
        }*/
        this.lifecycle.textContent = meeting?.status || 'Idle';
        this.joinStatus.textContent = isArchiveReadOnlyView ? 'Archived' : (isJoined ? 'Joined' : 'Not joined');
        this.joinPayload.value = this.state.session ? JSON.stringify(this.state.session, null, 2) : '';
        this.roomConnectionState.textContent = this.state.roomState;
        if (this.chatInput) {
            this.chatInput.disabled = isArchiveReadOnlyView;
            this.chatInput.placeholder = isArchiveReadOnlyView ? 'Archived room chat is read-only.' : 'Type a message...';
        }
        const sendChatButton = this.element.querySelector('[data-local-action="sendChat"]');
        if (sendChatButton) {
            sendChatButton.disabled = isArchiveReadOnlyView;
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
        const meeting = this.selectedMeeting;
        const isArchiveReadOnlyView = Boolean(
            this.canManageRooms()
            && meeting
            && (String(meeting?.status || '').trim().toLowerCase() === 'archived' || Boolean(String(meeting?.archivedAt || '').trim()))
            && !this.state.session?.participantIdentity
        );
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
        `, true, isArchiveReadOnlyView
            ? '<div class="webmeet-chat-empty">No messages in this archived room.</div>'
            : '<div class="webmeet-chat-empty">No messages yet. Start the conversation.</div>');

    }

};
