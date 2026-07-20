import { BlackboardNetworkAdapter } from '../services/blackboard/blackboard-network-adapter.js';
import { runWebMeetTool } from '../services/webmeet-api-client.js';

function getMeetingId(dashboard) {
    return String(
        dashboard.state.session?.meeting?.id
        || dashboard.state.selectedMeetingId
        || ''
    ).trim();
}

function getParticipantId(dashboard) {
    return String(
        dashboard.state.session?.participantIdentity
        || dashboard.state.session?.participant?.id
        || dashboard.state.session?.participant?.identity
        || dashboard.room?.localParticipant?.identity
        || ''
    ).trim();
}

function getParticipantName(dashboard, participantId = '') {
    const id = String(participantId || '').trim();
    const sessionParticipant = dashboard.state.session?.participant || {};
    const localParticipant = dashboard.room?.localParticipant || dashboard.webMeetRoom?.localParticipant || {};
    const stateParticipant = dashboard.state.participants?.find?.((entry) => String(entry?.identity || entry?.participantId || entry?.id || '').trim() === id) || {};
    return String(
        stateParticipant.name
        || stateParticipant.displayName
        || sessionParticipant.name
        || sessionParticipant.displayName
        || localParticipant.name
        || localParticipant.displayName
        || localParticipant.metadata?.name
        || id
    ).trim();
}

function getRoboTeamBlackboardBoardId() {
    return 'agent:agent_robo_team';
}

function dispatchBlackboardPanelEvent(panel, type, detail = {}) {
    if (!panel) return;
    panel.dispatchEvent(new CustomEvent(type, {
        bubbles: false,
        composed: false,
        detail
    }));
}

export const blackboardMethods = {
    async handleBlackboardPanelReady(event = null) {
        if (event?.target && event.target !== this.blackboardPanel) {
            return;
        }
        this.blackboardPanelReady = true;
        if (!this.state.blackboard?.visible) {
            return;
        }
        await this.connectBlackboardPanel();
        this.renderBlackboardSurface();
    },

    async ensureBlackboardAdapter() {
        const roomId = getMeetingId(this);
        const boardId = getRoboTeamBlackboardBoardId();
        const participantId = getParticipantId(this);
        const participantName = getParticipantName(this, participantId);
        if (!roomId || !participantId) {
            throw new Error('Join a meeting before opening the blackboard.');
        }
        if (
            this.blackboardAdapter
            && this.blackboardAdapter.roomId === roomId
            && this.blackboardAdapter.boardId === boardId
            && this.blackboardAdapter.participantId === participantId
        ) {
            this.blackboardAdapter.participantName = participantName;
            return this.blackboardAdapter;
        }
        this.blackboardAdapter?.unsubscribe?.();
        this.blackboardAdapter = new BlackboardNetworkAdapter({
            roomId,
            boardId,
            participantId,
            participantName,
            runTool: runWebMeetTool,
            onAuditMessage: (message) => {
                this.state.chat = Array.isArray(this.state.chat) ? this.state.chat : [];
                const index = this.state.chat.findIndex((entry) => entry?.id === message?.id);
                if (index >= 0) this.state.chat[index] = message;
                else this.state.chat.push(message);
                this.renderFeedLists();
            },
            publishRealtimePayload: (payload) => this.publishRealtimePayload(payload),
            room: this.webMeetRoom
        });
        this.blackboardAdapter.subscribe((payload) => {
            const panel = this.blackboardPanel;
            if (payload.kind === 'blackboard' && panel) {
                dispatchBlackboardPanelEvent(panel, 'webmeet-blackboard-update', {
                    blackboard: payload.object
                });
                return;
            }
            if (payload.kind === 'widget' && panel) {
                dispatchBlackboardPanelEvent(panel, 'webmeet-blackboard-update', {
                    widget: payload.object
                });
                return;
            }
            if (payload.kind === 'scripta-presentation' && panel) {
                dispatchBlackboardPanelEvent(panel, 'webmeet-blackboard-update', {
                    scriptaPresentation: payload.presentation
                });
            }
        });
        return this.blackboardAdapter;
    },

    async connectBlackboardPanel() {
        const adapter = await this.ensureBlackboardAdapter();
        if (!this.blackboardPanel) {
            throw new Error('Blackboard panel is not rendered.');
        }
        const blackboard = await adapter.loadInitialBlackboard();
        dispatchBlackboardPanelEvent(this.blackboardPanel, 'webmeet-blackboard-connect', {
            adapter,
            blackboard
        });
    },

    async toggleBlackboard() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before opening the blackboard.');
            return;
        }
        const participantId = getParticipantId(this);
        const meetingId = getMeetingId(this);
        const isLocalPresenter = this.state.blackboard?.visible
            && this.state.blackboard?.presenterId === participantId;
        const visible = !isLocalPresenter;
        const adapter = await this.ensureBlackboardAdapter();
        const response = await adapter.sendEvent(visible ? 'show' : 'hide', {}, {
            targetType: 'blackboard'
        });
        await this.applyBlackboardVisibility(response.visibilityPayload || { meetingId, participantId, visible });
    },

    async applyBlackboardVisibility(payload = {}) {
        const visible = payload.visible === true;
        const participantId = String(payload.participantId || '').trim();
        const presenterId = String(payload.presenterId || participantId).trim();
        const presenterName = String(payload.presenterName || '').trim();
        this.state.blackboard = {
            ...(this.state.blackboard || {}),
            visible,
            presenterId: visible ? presenterId : '',
            presenterName: visible ? (presenterName || this.getBlackboardPresenterName(presenterId)) : ''
        };
        if (visible && this.blackboardPanelReady) {
            await this.connectBlackboardPanel();
        }
        this.renderBlackboardSurface();
    },

    async handleBlackboardUpdatedEvent(event = null) {
        if (!this.state.blackboard?.visible) {
            return;
        }
        const adapter = await this.ensureBlackboardAdapter();
        const encodedEvent = String(event?.detail?.encodedEvent || event?.detail?.parsed?.encoded || '').trim();
        if (encodedEvent) {
            await adapter.handleEncodedEvent(encodedEvent);
            return;
        }
        await adapter.requestResync('blackboard.updated');
    },

    getBlackboardPresenterName(participantId = '') {
        const id = String(participantId || '').trim();
        if (!id) {
            return '';
        }
        const participant = this.state.participants?.find?.((entry) => String(entry?.identity || entry?.participantId || entry?.id || '').trim() === id);
        return String(participant?.name || participant?.displayName || participant?.identity || id).trim();
    },

    renderBlackboardSurface() {
        const visible = Boolean(this.state.blackboard?.visible);
        if (this.blackboardSurface) {
            this.blackboardSurface.classList.toggle('webmeet-hidden', !visible);
            this.blackboardSurface.classList.toggle('is-focused', visible);
        }
        if (this.blackboardPresenter) {
            const presenterName = String(this.state.blackboard?.presenterName || '').trim();
            this.blackboardPresenter.textContent = visible && presenterName ? presenterName : '';
        }
        if (this.blackboardButton) {
            this.blackboardButton.classList.toggle('active', visible);
            const presenterName = String(this.state.blackboard?.presenterName || '').trim();
            const label = visible
                ? `Hide Blackboard${presenterName ? ` - ${presenterName}` : ''}`
                : 'Show Blackboard';
            this.blackboardButton.title = label;
            this.blackboardButton.setAttribute('aria-label', label);
            this.blackboardButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
        }
        if (visible) {
            this.applyBlackboardFocusLayout?.();
        } else {
            this.participantLayoutController?.renderParticipantLayout?.();
        }
    },

    collapseBlackboardFocus() {
        this.state.blackboard = {
            ...(this.state.blackboard || {}),
            visible: false,
            presenterId: '',
            presenterName: ''
        };
        if (this.blackboardSurface) {
            this.blackboardSurface.classList.add('webmeet-hidden');
            this.blackboardSurface.classList.remove('is-focused');
        }
        if (this.blackboardPresenter) {
            this.blackboardPresenter.textContent = '';
        }
        if (this.blackboardButton) {
            this.blackboardButton.classList.remove('active');
            this.blackboardButton.title = 'Show Blackboard';
            this.blackboardButton.setAttribute('aria-label', 'Show Blackboard');
            this.blackboardButton.setAttribute('aria-pressed', 'false');
        }
    },

    applyBlackboardFocusLayout() {
        if (!this.state.blackboard?.visible || !this.videoGridAll || !this.blackboardSurface) {
            return;
        }
        if (this.blackboardSurface.parentElement !== this.videoGridAll) {
            this.videoGridAll.prepend(this.blackboardSurface);
        }
        this.blackboardSurface.classList.remove('webmeet-hidden');
        this.blackboardSurface.classList.add('is-focused');
        this.videoGridEmpty?.classList.add('webmeet-hidden');
        this.videoGridAll.classList.remove('webmeet-hidden');
        this.videoGridAll.classList.add('has-focus');
        if (this.videoGridThumbnails) {
            this.videoGridThumbnails.classList.add('webmeet-hidden');
            this.videoGridThumbnails.classList.remove('has-focus');
        }
        if (this.participantLayoutController) {
            this.participantLayoutController.focusedParticipantId = '';
            for (const view of this.participantLayoutController.participantViews?.values?.() || []) {
                view.isFocused = false;
                view.isMini = true;
                if (view.element?.parentElement !== this.videoGridAll) {
                    this.videoGridAll.appendChild(view.element);
                }
                this.participantLayoutController.applyParticipantViewState?.(view);
            }
        }
    },

    resetBlackboardUiState() {
        this.state.blackboard = {
            visible: false,
            presenterId: '',
            presenterName: ''
        };
        this.blackboardAdapter?.unsubscribe?.();
        this.blackboardAdapter = null;
        dispatchBlackboardPanelEvent(this.blackboardPanel, 'webmeet-blackboard-disconnect');
        this.renderBlackboardSurface();
    }
};
