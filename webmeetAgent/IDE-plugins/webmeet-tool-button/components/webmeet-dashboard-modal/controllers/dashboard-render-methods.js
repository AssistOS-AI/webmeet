import { escapeHtml, formatDate } from '../services/dashboard-utils.js';

export const dashboardRenderMethods = {
    renderAll() {
        const canManageRooms = this.canManageRooms();
        if (this.createRoomButton) {
            this.createRoomButton.classList.toggle('webmeet-hidden', !canManageRooms);
        }
        this.renderWorkspaceList();
        this.renderMeetingList();
        this.renderMeetingSummary();
        this.renderFeedLists();
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
            this.recordingButton.classList.toggle('webmeet-hidden', this.isGuestSession());
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
        const mediaBusy = Object.values(this.state.mediaLoading || {}).some(Boolean);
        const setMediaButtonLoading = (button, type) => {
            if (!button) return;
            const isLoading = Boolean(this.state.mediaLoading?.[type]);
            button.classList.toggle('is-loading', isLoading);
            button.disabled = mediaBusy;
            button.setAttribute('aria-busy', isLoading ? 'true' : 'false');
        };
        setMediaButtonLoading(this.micButton, 'microphone');
        setMediaButtonLoading(this.cameraButton, 'camera');
        setMediaButtonLoading(this.screenShareButton, 'screen');
    },

    renderFeedLists() {
        const renderFeed = (target, entries, formatter, shouldScroll = false, emptyHtml = '<div class="webmeet-feed-item">No data yet.</div>') => {
            const safeEntries = Array.isArray(entries) ? entries : [];
            target.innerHTML = safeEntries.map(formatter).join('') || emptyHtml;
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

};
