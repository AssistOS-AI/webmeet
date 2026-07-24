import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    createChatAutocomplete,
    createExplorerSearchAdapter,
    createWorkspacePathsProvider,
    renderComposerMentionOverlayHtml
} from '../services/chat-autocomplete/index.js';
import { createBrowserRoboSpeechInput } from '../services/browser-robo-speech-input.js';
import { WEBMEET_EVENT_TYPES } from '../services/webmeet-events.js';

const runTool = runWebMeetTool;

async function defaultCallExplorerTool(name, args, options) {
    const client = window.webSkel?.appServices?.getClient?.('explorer');
    if (!client || typeof client.callTool !== 'function') return null;
    return client.callTool(name, args || {}, options || {});
}

async function defaultResolveWorkspaceRoot() {
    try {
        const { getWorkspaceRoot } = await import('/explorer/utils/workspaceRoot.js');
        if (typeof getWorkspaceRoot === 'function') {
            return await getWorkspaceRoot();
        }
    } catch (_) {
        // workspaceRoot module not reachable; caller will fall back gracefully.
    }
    return '';
}

export class ChatComponent {
    constructor(options = {}) {
        this.isGuestSession = options.isGuestSession || (() => false);
        this.sendPublicChat = options.sendPublicChat;
        this.getState = options.getState || (() => ({}));
        this.setState = options.setState || (() => {});
        this.setError = options.setError || console.error;
        this.getSelectedMeeting = options.getSelectedMeeting || (() => null);
        this.getSession = options.getSession || (() => null);
        this.renderFeedLists = options.renderFeedLists || (() => {});
        this.publishRealtimePayload = options.publishRealtimePayload || (() => Promise.resolve());
        this.refreshBlackboard = options.refreshBlackboard || (() => Promise.resolve());
        this.updateRoboCommandStatus = options.updateRoboCommandStatus || (() => Promise.resolve());
        this.updateRoboDraftState = options.updateRoboDraftState || (() => {});
        this.loadMeetingDetails = options.loadMeetingDetails || (() => Promise.resolve());
        this.getRoom = options.getRoom || (() => null);
        this.runTool = typeof options.runTool === 'function' ? options.runTool : runTool;
        this.callExplorerTool = typeof options.callExplorerTool === 'function'
            ? options.callExplorerTool
            : defaultCallExplorerTool;
        this.resolveWorkspaceRoot = typeof options.resolveWorkspaceRoot === 'function'
            ? options.resolveWorkspaceRoot
            : defaultResolveWorkspaceRoot;
        this.elements = {};
        this.autocomplete = null;
        this.autocompleteInput = null;
        this.autocompleteKeydownHandler = null;
        this.mentionOverlay = null;
        this.mentionOverlayInput = null;
        this.mentionOverlayHandlers = null;
        this.selectedMentionTokens = new Set();
        this.roboSpeechInput = null;
    }

    getKnownAgentTokens() {
        return [];
    }

    getComposerMentionTokens() {
        return [
            ...this.getKnownAgentTokens(),
            ...this.selectedMentionTokens
        ];
    }

    setElements(elements) {
        this.destroyRoboSpeechInput();
        this.elements = elements;
        this.syncRoboDraftState();
        this.initChatAutocomplete();
        this.initRoboSpeechInput();
    }

    initRoboSpeechInput() {
        const input = this.elements?.chatInput;
        const button = this.elements?.chatActionButton;
        if (!input || !button) return;
        this.roboSpeechInput = createBrowserRoboSpeechInput({
            input,
            button,
            status: this.elements?.chatSpeechStatus || null,
            getLanguage: () => this.getState()?.mediaSettings?.speechRecognitionLanguage,
            onSubmit: () => this.sendChat(),
            onError: (message) => this.setError(message)
        });
    }

    destroyRoboSpeechInput() {
        this.roboSpeechInput?.destroy?.();
        this.roboSpeechInput = null;
    }

    async prepareRoboMicrophonePermission() {
        const result = await this.roboSpeechInput?.prepareMicrophonePermission?.();
        if (result?.status === 'denied') {
            this.setError('Microphone access was not granted. Push-to-talk will remain unavailable until microphone access is allowed.');
        } else if (result?.status === 'error') {
            this.setError('WebMeet could not prepare microphone access for push-to-talk. You can still join the room.');
        }
        return result || { status: 'unsupported', requested: false };
    }

    destroy() {
        this.destroyRoboSpeechInput();
        this.destroyChatAutocomplete();
    }

    syncRoboDraftState() {
        const value = String(this.elements?.chatInput?.value || '');
        this.updateRoboDraftState(/^\s*\/robo(?:\s|$)/i.test(value));
    }

    initChatAutocomplete() {
        this.destroyChatAutocomplete();
        const input = this.elements?.chatInput;
        if (!input || typeof window === 'undefined' || typeof document === 'undefined') return;
        const composer = input.closest('.webmeet-compose') || input.parentElement || null;
        const inputShell = this.ensureChatInputShell(input, composer);
        const providers = [];
        if (!this.isGuestSession()) {
            const searchAdapter = createExplorerSearchAdapter({
                callExplorerTool: (name, args, options) => this.callExplorerTool(name, args, options),
                resolveWorkspaceRoot: () => this.resolveWorkspaceRoot()
            });
            if (searchAdapter) {
                const pathsProvider = createWorkspacePathsProvider({
                    searchPaths: (query) => searchAdapter.searchPaths(query)
                });
                if (pathsProvider) providers.push(pathsProvider);
            }
        }

        if (composer && typeof getComputedStyle === 'function' && getComputedStyle(composer).position === 'static') {
            composer.style.position = 'relative';
        }
        this.initComposerMentionOverlay(input, inputShell);

        this.autocomplete = createChatAutocomplete({
            input,
            menuContainer: inputShell || composer,
            providers,
            onSelectionApplied: ({ next }) => {
                this.recordSelectedMention(next?.token);
                this.updateComposerMentionOverlay();
            }
        });
        this.autocompleteInput = input;
        this.autocompleteKeydownHandler = (event) => {
            this.autocomplete?.handleKeydown(event);
        };
        // Keydown listener in capture phase keeps autocomplete from being preempted
        // by the chat send-on-Enter shortcut wired in webmeet-dashboard.
        input.addEventListener('keydown', this.autocompleteKeydownHandler, true);
    }

    ensureChatInputShell(input, composer) {
        if (!input || !composer) return input?.parentElement || null;
        if (input.parentElement?.classList?.contains('webmeet-chat-input-shell')) {
            return input.parentElement;
        }
        const shell = document.createElement('div');
        shell.className = 'webmeet-chat-input-shell';
        composer.insertBefore(shell, input);
        shell.appendChild(input);
        return shell;
    }

    recordSelectedMention(token) {
        const value = String(token || '').trim();
        if (!value.startsWith('@') || /\s/.test(value)) return;
        this.selectedMentionTokens.add(value);
    }

    pruneSelectedMentionTokens() {
        const value = String(this.mentionOverlayInput?.value || '');
        for (const token of Array.from(this.selectedMentionTokens)) {
            if (!value.includes(token)) {
                this.selectedMentionTokens.delete(token);
            }
        }
    }

    initComposerMentionOverlay(input, inputShell) {
        this.destroyComposerMentionOverlay();
        if (!input || !inputShell || typeof document === 'undefined') return;
        const overlay = document.createElement('div');
        overlay.className = 'webmeet-chat-input-highlights';
        overlay.setAttribute('aria-hidden', 'true');
        inputShell.insertBefore(overlay, input);
        input.classList.add('webmeet-chat-input-highlighted');
        this.mentionOverlay = overlay;
        this.mentionOverlayInput = input;

        const update = () => this.updateComposerMentionOverlay();
        const syncScroll = () => this.syncComposerMentionOverlayScroll();
        input.addEventListener('input', update);
        input.addEventListener('scroll', syncScroll);
        this.mentionOverlayHandlers = { update, syncScroll };
        this.updateComposerMentionOverlay();
    }

    updateComposerMentionOverlay() {
        this.syncRoboDraftState();
        this.roboSpeechInput?.sync?.();
        if (!this.mentionOverlay || !this.mentionOverlayInput) return;
        this.pruneSelectedMentionTokens();
        this.mentionOverlay.innerHTML = renderComposerMentionOverlayHtml(
            this.mentionOverlayInput.value || '',
            this.getComposerMentionTokens()
        );
        this.syncComposerMentionOverlayScroll();
    }

    syncComposerMentionOverlayScroll() {
        if (!this.mentionOverlay || !this.mentionOverlayInput) return;
        this.mentionOverlay.scrollTop = this.mentionOverlayInput.scrollTop || 0;
        this.mentionOverlay.scrollLeft = this.mentionOverlayInput.scrollLeft || 0;
    }

    destroyComposerMentionOverlay() {
        if (this.mentionOverlayInput && this.mentionOverlayHandlers) {
            this.mentionOverlayInput.removeEventListener('input', this.mentionOverlayHandlers.update);
            this.mentionOverlayInput.removeEventListener('scroll', this.mentionOverlayHandlers.syncScroll);
        }
        if (this.mentionOverlayInput) {
            this.mentionOverlayInput.classList.remove('webmeet-chat-input-highlighted');
        }
        if (this.mentionOverlay) {
            this.mentionOverlay.remove();
        }
        this.mentionOverlay = null;
        this.mentionOverlayInput = null;
        this.mentionOverlayHandlers = null;
    }

    destroyChatAutocomplete() {
        if (this.autocompleteInput && this.autocompleteKeydownHandler) {
            this.autocompleteInput.removeEventListener('keydown', this.autocompleteKeydownHandler, true);
        }
        if (this.autocomplete) {
            this.autocomplete.destroy();
        }
        this.autocomplete = null;
        this.autocompleteInput = null;
        this.autocompleteKeydownHandler = null;
        this.destroyComposerMentionOverlay();
    }

    async sendChat() {
        const meeting = this.getSelectedMeeting();
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        const session = this.getSession();
        if (!session?.participantIdentity) {
            this.setError('Join the meeting before sending chat messages.');
            return;
        }
        const message = String(this.elements.chatInput?.value || '').trim();
        if (!message) return;

        if (/^\/(?:robo|event)(?:\s|$)/i.test(message)) {
            await this._sendEventCommand(meeting, message, session);
            return;
        }

        if (this.isGuestSession()) {
            await this._sendGuestChat(meeting, message, session);
            return;
        }

        try {
            const result = await this.runTool('webmeet_chat_send', {
                meetingId: meeting.id,
                authorId: session.participantIdentity,
                authorName: session.participant?.displayName || 'User',
                message
            });
            const persistedMessage = result?.message && typeof result.message === 'object'
                ? result.message
                : null;
            if (!persistedMessage) {
                throw new Error('Chat send did not return a message.');
            }
            const state = this.getState();
            state.chat = Array.isArray(state.chat) ? state.chat : [];
            if (!state.chat.some((entry) => entry?.id && entry.id === persistedMessage.id)) {
                state.chat.push(persistedMessage);
            }
            this.elements.chatInput.value = '';
            this.updateComposerMentionOverlay();
            this.renderFeedLists();
            if (this.getRoom()?.localParticipant) {
                try {
                    await this.publishRealtimePayload({
                        type: WEBMEET_EVENT_TYPES.CHAT_REALTIME,
                        meetingId: meeting.id,
                        message: {
                            ...persistedMessage,
                            authorId: session.participantIdentity
                        }
                    });
                } catch (err) {
                    // Persisted chat already succeeded; realtime delivery is best effort.
                }
            }
            void this.loadMeetingDetails().then(() => this.renderFeedLists()).catch(() => {});
        } catch (error) {
            this.setError(`Failed to send message: ${error.message}`);
        }
    }

    async _sendEventCommand(meeting, message, session) {
        const isRobo = /^\/robo(?:\s|$)/i.test(message);
        const commandId = `command_${globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(16).slice(2)}`}`;
        const participantId = String(session.participantIdentity || '').trim();
        const notifyStatus = (state, errorMessage = '') => {
            if (!isRobo) return;
            try {
                void Promise.resolve(this.updateRoboCommandStatus({
                    meetingId: meeting.id,
                    boardId: 'agent:agent_robo_team',
                    commandId,
                    participantId,
                    state,
                    ...(errorMessage ? { errorMessage } : {})
                })).catch(() => {});
            } catch (_) {}
        };
        notifyStatus('started');
        try {
            this.elements.chatInput.value = '';
            this.updateComposerMentionOverlay();
            const eventInput = isRobo ? message : message.replace(/^\/event\s*/i, '').trim();
            const result = await this.runTool('webmeet_event_command', {
                roomId: meeting.id,
                event: eventInput,
                source: isRobo ? 'robo' : 'event',
                commandSource: 'chat',
                participantId,
                commandId
            });
            if (result?.auditMessage) {
                const state = this.getState();
                state.chat = Array.isArray(state.chat) ? state.chat : [];
                const index = state.chat.findIndex((entry) => entry?.id === result.auditMessage.id);
                if (index >= 0) state.chat[index] = result.auditMessage;
                else state.chat.push(result.auditMessage);
                if (this.getRoom()?.localParticipant) {
                    await this.publishRealtimePayload({
                        type: WEBMEET_EVENT_TYPES.CHAT_REALTIME,
                        meetingId: meeting.id,
                        message: result.auditMessage
                    }).catch(() => {});
                }
            }
            if (result?.ok === false) throw new Error(result?.error?.message || 'Blackboard event failed.');
            if (result?.visibilityPayload || result?.blackboard) {
                await this.refreshBlackboard(result).catch(() => {});
            }
            if (result?.blackboard) {
                if (this.getRoom()?.localParticipant) {
                    await this.publishRealtimePayload({
                        type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
                        meetingId: meeting.id,
                        boardId: 'agent:agent_robo_team',
                        blackboardRevision: Number(result.blackboard.revision || 0),
                        changeType: 'update'
                    }).catch(() => {});
                }
            }
            this.renderFeedLists();
            notifyStatus('success');
        } catch (error) {
            notifyStatus('error', error?.message || 'The blackboard command failed.');
            this.setError(`Failed to run blackboard event: ${error.message}`);
        }
    }

    async _sendGuestChat(meeting, message, session) {
        try {
            const result = await this.sendPublicChat(meeting.id, message);
            this.elements.chatInput.value = '';
            this.updateComposerMentionOverlay();
            const newMessage = result?.message || {
                authorId: session.participantIdentity,
                authorName: session.participant?.displayName || 'Guest',
                message,
                createdAt: new Date().toISOString()
            };
            const state = this.getState();
            state.chat.push(newMessage);
            this.renderFeedLists();

            if (this.getRoom()?.localParticipant) {
                try {
                    const chatPayload = {
                        type: WEBMEET_EVENT_TYPES.CHAT_REALTIME,
                        meetingId: meeting.id,
                        message: newMessage
                    };
                    await this.publishRealtimePayload(chatPayload);
                } catch (err) {
                    // Persisted chat already succeeded; realtime delivery is best effort.
                }
            }
        } catch (error) {
            this.setError(`Failed to send message: ${error.message}`);
        }
    }

}
