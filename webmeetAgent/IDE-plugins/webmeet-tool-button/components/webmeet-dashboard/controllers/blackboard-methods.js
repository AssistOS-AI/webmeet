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

function dispatchBlackboardPanelEvent(panel, type, detail = {}) {
    if (!panel) return;
    panel.dispatchEvent(new CustomEvent(type, {
        bubbles: false,
        composed: false,
        detail
    }));
}

const ROBO_STATUS_SUCCESS_MS = 4_000;
const ROBO_STATUS_ERROR_MS = 10_000;
const ROBO_STATUS_STARTED_TIMEOUT_MS = 75_000;

function roboStatusErrorDurationMs(message = '') {
    const readingDuration = (String(message || '').length / 6) * 1_000 + 4_000;
    return Math.max(ROBO_STATUS_ERROR_MS, Math.ceil(readingDuration));
}

export const blackboardMethods = {
    setRoboCommandDraftActive(active) {
        const next = active === true;
        if (next === this.roboCommandDraftActive) return;
        this.roboCommandDraftActive = next;
        this.renderRoboCommandStatus();
    },

    resolveRoboStatusParticipantName(participantId = '') {
        const id = String(participantId || '').trim();
        const participant = this.state.participants?.find?.((entry) => String(entry?.identity || entry?.participantId || entry?.id || '').trim() === id);
        const localId = getParticipantId(this);
        const localName = id && id === localId ? getParticipantName(this, id) : '';
        return String(participant?.name || participant?.displayName || localName || id || 'Participant').trim();
    },

    async updateRoboCommandStatus(input = {}, { publish = false } = {}) {
        const meetingId = String(input.meetingId || getMeetingId(this)).trim();
        const selectedMeetingId = getMeetingId(this);
        const boardId = String(input.boardId || this.blackboardAdapter?.boardId || '').trim();
        const commandId = String(input.commandId || '').trim();
        const participantId = String(input.participantId || '').trim();
        const state = String(input.state || '').trim();
        if (!meetingId || meetingId !== selectedMeetingId || !boardId) return;
        if (!commandId || !participantId || !['started', 'success', 'error'].includes(state)) return;

        if (state === 'started') {
            for (const [id, entry] of this.roboCommandStatuses) {
                if (entry.state !== 'started') {
                    this.roboCommandStatuses.delete(id);
                    globalThis.clearTimeout(this.roboCommandStatusTimers.get(id));
                    this.roboCommandStatusTimers.delete(id);
                }
            }
        }
        globalThis.clearTimeout(this.roboCommandStatusTimers.get(commandId));
        const participantName = this.resolveRoboStatusParticipantName(participantId);
        const errorMessage = String(input.errorMessage || '').trim().slice(0, 500);
        this.roboCommandStatuses.set(commandId, { commandId, participantId, participantName, state, errorMessage });

        const duration = state === 'started'
            ? ROBO_STATUS_STARTED_TIMEOUT_MS
            : state === 'success' ? ROBO_STATUS_SUCCESS_MS : roboStatusErrorDurationMs(errorMessage);
        const timer = globalThis.setTimeout(() => {
            if (state === 'started' && this.roboCommandStatuses.get(commandId)?.state === 'started') {
                this.roboCommandStatuses.set(commandId, {
                    commandId, participantId, participantName, state: 'error',
                    errorMessage: 'Blackboard command status expired before a result was received.'
                });
                this.renderRoboCommandStatus();
                this.roboCommandStatusTimers.set(commandId, globalThis.setTimeout(() => {
                    this.roboCommandStatuses.delete(commandId);
                    this.roboCommandStatusTimers.delete(commandId);
                    this.renderRoboCommandStatus();
                }, roboStatusErrorDurationMs('Blackboard command status expired before a result was received.')));
                return;
            }
            this.roboCommandStatuses.delete(commandId);
            this.roboCommandStatusTimers.delete(commandId);
            this.renderRoboCommandStatus();
        }, duration);
        this.roboCommandStatusTimers.set(commandId, timer);
        this.renderRoboCommandStatus();

        if (publish) {
            await this.publishRealtimePayload({
                type: 'blackboard.command_status', meetingId, boardId, commandId, participantId, state,
                ...(state === 'error' && errorMessage ? { errorMessage } : {})
            }).catch(() => {});
        }
    },

    renderRoboCommandStatus() {
        const entries = [...this.roboCommandStatuses.values()];
        const active = entries.some((entry) => entry.state === 'started');
        dispatchBlackboardPanelEvent(this.blackboardPanel, 'webmeet-blackboard-robo-status', {
            active: active || this.roboCommandDraftActive === true
        });
        if (!this.blackboardCommandStatus) return;
        this.blackboardCommandStatus.replaceChildren();
        this.blackboardCommandStatus.hidden = entries.length === 0;
        this.blackboardCommandStatus.dataset.state = active
            ? 'started'
            : entries.some((entry) => entry.state === 'error') ? 'error' : 'success';
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = 'webmeet-blackboard-command-status-row';
            row.dataset.state = entry.state;
            const text = document.createElement('span');
            text.className = 'webmeet-blackboard-command-status-text';
            text.textContent = entry.state === 'started'
                ? `${entry.participantName} is editing now`
                : entry.state === 'success'
                    ? `${entry.participantName} finished editing`
                    : (entry.errorMessage || 'The blackboard command failed.');
            if (entry.state === 'started') {
                const activity = document.createElement('span');
                activity.className = 'webmeet-blackboard-command-status-activity';
                activity.setAttribute('aria-hidden', 'true');
                for (let index = 0; index < 3; index += 1) {
                    const dot = document.createElement('span');
                    dot.className = 'webmeet-blackboard-command-status-dot';
                    activity.append(dot);
                }
                text.append(activity);
            }
            row.append(text);
            this.blackboardCommandStatus.append(row);
        }
        this.measureRoboCommandStatusOverflow();
    },

    measureRoboCommandStatusOverflow() {
        const status = this.blackboardCommandStatus;
        if (!status || status.hidden) return;
        const measure = () => {
            for (const row of status.querySelectorAll('.webmeet-blackboard-command-status-row')) {
                const text = row.querySelector('.webmeet-blackboard-command-status-text');
                if (!text) continue;
                row.classList.remove('is-scrolling');
                row.style.removeProperty('--webmeet-status-scroll-start');
                row.style.removeProperty('--webmeet-status-scroll-end');
                row.style.removeProperty('--webmeet-status-scroll-duration');
                const viewportWidth = Math.max(0, Math.ceil(row.clientWidth));
                const textWidth = Math.max(0, Math.ceil(text.scrollWidth));
                if (textWidth - viewportWidth <= 1) continue;
                const travelDistance = viewportWidth + textWidth;
                row.style.setProperty('--webmeet-status-scroll-start', `${viewportWidth}px`);
                row.style.setProperty('--webmeet-status-scroll-end', `${-textWidth}px`);
                row.style.setProperty('--webmeet-status-scroll-duration', `${Math.max(8, travelDistance / 45).toFixed(2)}s`);
                row.classList.add('is-scrolling');
            }
        };
        measure();
    },

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
        const participantId = getParticipantId(this);
        const participantName = getParticipantName(this, participantId);
        if (!roomId || !participantId) {
            throw new Error('Join a meeting before opening the blackboard.');
        }
        if (
            this.blackboardAdapter
            && this.blackboardAdapter.roomId === roomId
            && this.blackboardAdapter.participantId === participantId
        ) {
            this.blackboardAdapter.participantName = participantName;
            return this.blackboardAdapter;
        }
        this.blackboardAdapter?.unsubscribe?.();
        this.blackboardAdapter = new BlackboardNetworkAdapter({
            roomId,
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
            if (payload.kind === 'workspace' && panel) {
                dispatchBlackboardPanelEvent(panel, 'webmeet-blackboard-update', { workspace: payload.object });
                return;
            }
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
            blackboard,
            workspace: adapter.workspace,
        });
    },

    async refreshChatBlackboard(result = {}, options = {}) {
        if (result.visibilityPayload) {
            await this.applyBlackboardVisibility(result.visibilityPayload);
        }
        if (options.ensureVisible && !this.state.blackboard?.visible) {
            await this.applyBlackboardVisibility({
                meetingId: this.selectedMeeting?.id || '',
                participantId: this.state.session?.participantIdentity || '',
                visible: true,
                presenterId: 'agent_robo_team',
                presenterName: 'RoboTeam'
            });
        }
        if (!this.state.blackboard?.visible) return;
        const adapter = await this.ensureBlackboardAdapter();
        if (result.workspace) {
            adapter.applyWorkspaceProjection(result.workspace, { reason: 'command-result' });
        }
        if (result.blackboard) {
            adapter.applyBlackboardProjection(result.blackboard, { reason: 'command-result' });
        }
    },

    async toggleBlackboard() {
        if (!this.room?.localParticipant) {
            this.setError('Join a meeting before opening the blackboard.');
            return;
        }
        const participantId = getParticipantId(this);
        const meetingId = getMeetingId(this);
        if (this.state.blackboard?.visible) {
            this.collapseBlackboardFocus();
            this.participantLayoutController?.renderParticipantLayout?.();
            return;
        }
        await this.applyBlackboardVisibility({
            meetingId,
            participantId,
            visible: true,
            presenterId: 'agent_robo_team',
            presenterName: 'RoboTeam'
        });
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
        for (const timer of this.roboCommandStatusTimers.values()) globalThis.clearTimeout(timer);
        this.roboCommandStatusTimers.clear();
        this.roboCommandStatuses.clear();
        this.roboCommandDraftActive = false;
        dispatchBlackboardPanelEvent(this.blackboardPanel, 'webmeet-blackboard-disconnect');
        this.renderRoboCommandStatus();
        this.renderBlackboardSurface();
    }
};
