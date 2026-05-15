import { runWebMeetTool } from '../services/webmeet-api-client.js';
import {
    createChatAutocomplete,
    createAgentTagProvider,
    createExplorerSearchAdapter,
    createWorkspacePathsProvider,
    renderComposerMentionOverlayHtml
} from '../services/chat-autocomplete/index.js';

const runTool = runWebMeetTool;

async function defaultCallExplorerTool(name, args, options) {
    const { callExplorerTool } = await import('/explorer/services/infrastructure/explorerApi.js');
    return callExplorerTool(name, args, options);
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

/**
 * ChatTranscriptComponent - Manages chat, transcript, artifacts, and recordings
 * Extracted from webmeet-dashboard-modal.js for better maintainability
 */
export class ChatTranscriptComponent {
    constructor(options = {}) {
        this.isGuestSession = options.isGuestSession || (() => false);
        this.sendPublicChat = options.sendPublicChat;
        this.callPublicGuestApi = options.callPublicGuestApi;
        this.canManageArtifacts = options.canManageArtifacts || (() => false);
        this.getState = options.getState || (() => ({}));
        this.setState = options.setState || (() => {});
        this.setError = options.setError || console.error;
        this.getSelectedMeeting = options.getSelectedMeeting || (() => null);
        this.getSession = options.getSession || (() => null);
        this.renderFeedLists = options.renderFeedLists || (() => {});
        this.renderMeetingSummary = options.renderMeetingSummary || (() => {});
        this.requestRenderAll = options.renderAll || (() => {});
        this.publishRealtimePayload = options.publishRealtimePayload || (() => Promise.resolve());
        this.loadMeetingDetails = options.loadMeetingDetails || (() => Promise.resolve());
        this.getRoom = options.getRoom || (() => null);
        this.runTool = typeof options.runTool === 'function' ? options.runTool : runTool;
        this.callExplorerTool = typeof options.callExplorerTool === 'function'
            ? options.callExplorerTool
            : defaultCallExplorerTool;
        this.resolveWorkspaceRoot = typeof options.resolveWorkspaceRoot === 'function'
            ? options.resolveWorkspaceRoot
            : defaultResolveWorkspaceRoot;
        this.agentTagProvider = options.agentTagProvider || createAgentTagProvider();

        this.speechRecognition = null;
        this.elements = {};
        this.autocomplete = null;
        this.autocompleteInput = null;
        this.autocompleteKeydownHandler = null;
        this.mentionOverlay = null;
        this.mentionOverlayInput = null;
        this.mentionOverlayHandlers = null;
        this.selectedMentionTokens = new Set();
    }

    getKnownAgentTokens() {
        if (this.agentTagProvider && typeof this.agentTagProvider.getKnownTokens === 'function') {
            return this.agentTagProvider.getKnownTokens();
        }
        return [];
    }

    getComposerMentionTokens() {
        return [
            ...this.getKnownAgentTokens(),
            ...this.selectedMentionTokens
        ];
    }

    setElements(elements) {
        this.elements = elements;
        this.initChatAutocomplete();
    }

    initChatAutocomplete() {
        this.destroyChatAutocomplete();
        const input = this.elements?.chatInput;
        if (!input || typeof window === 'undefined' || typeof document === 'undefined') return;
        const composer = input.closest('.webmeet-compose') || input.parentElement || null;
        const inputShell = this.ensureChatInputShell(input, composer);
        const providers = [this.agentTagProvider];
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
        // by the chat send-on-Enter shortcut wired in webmeet-dashboard-modal.
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

        if (this.isGuestSession()) {
            await this._sendGuestChat(meeting, message, session);
            return;
        }

        await this.runTool('webmeet_chat_send', {
            meetingId: meeting.id,
            authorId: session.participantIdentity,
            authorName: session.participant?.displayName || 'User',
            message
        });
        this.elements.chatInput.value = '';
        this.updateComposerMentionOverlay();

        await this.loadMeetingDetails();
        this.renderFeedLists();

        if (this.getRoom()?.localParticipant) {
            try {
                const chatPayload = {
                    type: 'chat',
                    meetingId: meeting.id,
                    message: {
                        authorId: session.participantIdentity,
                        authorName: session.participant?.displayName || 'User',
                        message,
                        createdAt: new Date().toISOString()
                    }
                };
                await this.publishRealtimePayload(chatPayload);
            } catch (err) {
                // Persisted chat already succeeded; realtime delivery is best effort.
            }
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
                        type: 'chat',
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

    async appendTranscript() {
        const meeting = this.getSelectedMeeting();
        if (!meeting) {
            this.setError('Select a meeting first.');
            return;
        }
        const session = this.getSession();
        if (!session?.participantIdentity) {
            this.setError('Join the meeting before appending transcript.');
            return;
        }
        const text = String(this.elements.transcriptInput?.value || '').trim();
        const speakerName = String(this.elements.transcriptSpeaker?.value || session.participant?.displayName || '').trim();
        if (!text || !speakerName) return;

        await this.runTool('webmeet_transcript_append', {
            meetingId: meeting.id,
            speakerId: session.participantIdentity,
            speakerName,
            text
        });
        this.elements.transcriptInput.value = '';
        await this.loadMeetingDetails();
        this.requestRenderAll();
    }

    startSpeechRecognition() {
        if (this.isGuestSession() || !this.canManageArtifacts()) {
            this.setError('Only admin can append transcript.');
            return;
        }
        const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!Recognition) {
            this.setState({ transcriptState: 'Unavailable' });
            this.renderMeetingSummary();
            return;
        }
        this.stopSpeechRecognition();
        const recognition = new Recognition();
        recognition.continuous = true;
        recognition.interimResults = false;
        recognition.lang = navigator.language || 'en-US';
        recognition.onstart = () => {
            this.setState({ transcriptState: 'Listening' });
            this.renderMeetingSummary();
        };
        recognition.onerror = () => {
            this.setState({ transcriptState: 'Error' });
            this.renderMeetingSummary();
        };
        recognition.onend = () => {
            if (this.getState().transcriptState === 'Listening') {
                this.setState({ transcriptState: 'Idle' });
                this.renderMeetingSummary();
            }
        };
        recognition.onresult = async (event) => {
            const meeting = this.getSelectedMeeting();
            if (!meeting) return;
            const chunks = [];
            for (let i = event.resultIndex; i < event.results.length; i++) {
                if (event.results[i].isFinal) {
                    chunks.push(event.results[i][0].transcript);
                }
            }
            const text = chunks.join(' ').trim();
            if (!text) return;

            const session = this.getSession();
            await this.runTool('webmeet_transcript_append', {
                meetingId: meeting.id,
                speakerId: session.participantIdentity,
                speakerName: session.participant?.displayName || 'User',
                text
            });
            await this.loadMeetingDetails();
            this.requestRenderAll();
        };
        this.speechRecognition = recognition;
        try {
            recognition.start();
        } catch {
            this.setState({ transcriptState: 'Error' });
            this.renderMeetingSummary();
        }
    }

    stopSpeechRecognition() {
        if (this.speechRecognition) {
            try {
                this.speechRecognition.stop();
            } catch {}
            this.speechRecognition = null;
        }
    }

}
