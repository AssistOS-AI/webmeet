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
        this.executeBlackboardClientAction = options.executeBlackboardClientAction || (() => Promise.resolve());
        this.updateRoboCommandStatus = options.updateRoboCommandStatus || (() => Promise.resolve());
        this.updateRoboDraftState = options.updateRoboDraftState || (() => {});
        this.loadMeetingDetails = options.loadMeetingDetails || (() => Promise.resolve());
        this.getRoom = options.getRoom || (() => null);
        this.getActiveBoardId = options.getActiveBoardId || (() => '');
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
        this.attachmentUploadHandlers = null;
        this.attachmentUploadQueue = [];
        this.attachmentUploadDrainPromise = null;
        this.attachmentDragDepth = 0;
    }

    getKnownAgentTokens() {
        return [];
    }

    async resolveActiveBoardId(meeting, session) {
        const current = String(this.getActiveBoardId() || '').trim();
        if (current) return current;
        const response = await this.runTool('webmeet_blackboard_workspace_get', {
            roomId: String(meeting?.id || '').trim(),
            participantId: String(session?.participantIdentity || '').trim(),
        });
        return String(response?.workspace?.activeBoardId || response?.blackboard?.boardId || '').trim();
    }

    getComposerMentionTokens() {
        return [
            ...this.getKnownAgentTokens(),
            ...this.selectedMentionTokens
        ];
    }

    setElements(elements) {
        this.destroyAttachmentUpload();
        this.destroyRoboSpeechInput();
        this.elements = elements;
        this.syncRoboDraftState();
        this.initChatAutocomplete();
        this.initRoboSpeechInput();
        this.initAttachmentUpload();
        this.setAttachmentUploadBusy(Boolean(this.attachmentUploadDrainPromise));
    }

    initAttachmentUpload() {
        const input = this.elements?.chatFileInput;
        const composer = this.elements?.chatComposer
            || this.elements?.chatInput?.closest?.('.webmeet-compose')
            || null;
        if (!input || !composer) return;
        const onChange = () => {
            const files = Array.from(input.files || []);
            input.value = '';
            if (files.length) void this.publishAttachments(files);
        };
        const onPaste = (event) => {
            const files = this.getTransferredFiles(event.clipboardData);
            if (!files.length) return;
            event.preventDefault();
            void this.publishAttachments(files);
        };
        const onDragEnter = (event) => {
            if (!this.hasTransferredFiles(event.dataTransfer)) return;
            event.preventDefault();
            this.attachmentDragDepth += 1;
            this.setAttachmentDropActive(true);
        };
        const onDragOver = (event) => {
            if (!this.hasTransferredFiles(event.dataTransfer)) return;
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            this.setAttachmentDropActive(true);
        };
        const onDragLeave = (event) => {
            if (!this.attachmentDragDepth) return;
            event.preventDefault();
            this.attachmentDragDepth = Math.max(0, this.attachmentDragDepth - 1);
            if (!this.attachmentDragDepth) this.setAttachmentDropActive(false);
        };
        const onDrop = (event) => {
            if (!this.hasTransferredFiles(event.dataTransfer)) return;
            event.preventDefault();
            event.stopPropagation?.();
            const files = this.getTransferredFiles(event.dataTransfer);
            this.attachmentDragDepth = 0;
            this.setAttachmentDropActive(false);
            if (files.length) void this.publishAttachments(files);
        };
        input.addEventListener('change', onChange);
        composer.addEventListener('paste', onPaste);
        composer.addEventListener('dragenter', onDragEnter);
        composer.addEventListener('dragover', onDragOver);
        composer.addEventListener('dragleave', onDragLeave);
        composer.addEventListener('drop', onDrop);
        this.attachmentUploadHandlers = {
            input,
            composer,
            onChange,
            onPaste,
            onDragEnter,
            onDragOver,
            onDragLeave,
            onDrop
        };
    }

    destroyAttachmentUpload() {
        const handlers = this.attachmentUploadHandlers;
        handlers?.input?.removeEventListener?.('change', handlers.onChange);
        handlers?.composer?.removeEventListener?.('paste', handlers.onPaste);
        handlers?.composer?.removeEventListener?.('dragenter', handlers.onDragEnter);
        handlers?.composer?.removeEventListener?.('dragover', handlers.onDragOver);
        handlers?.composer?.removeEventListener?.('dragleave', handlers.onDragLeave);
        handlers?.composer?.removeEventListener?.('drop', handlers.onDrop);
        this.attachmentDragDepth = 0;
        this.setAttachmentDropActive(false);
        this.attachmentUploadHandlers = null;
    }

    getTransferredFiles(transfer = null) {
        const itemFiles = Array.from(transfer?.items || [])
            .filter((item) => item?.kind === 'file')
            .map((item) => item.getAsFile?.())
            .filter(Boolean);
        return itemFiles.length ? itemFiles : Array.from(transfer?.files || []).filter(Boolean);
    }

    hasTransferredFiles(transfer = null) {
        if (Array.from(transfer?.items || []).some((item) => item?.kind === 'file')) return true;
        if (Array.from(transfer?.files || []).length) return true;
        return Array.from(transfer?.types || []).includes('Files');
    }

    setAttachmentDropActive(active) {
        const isActive = active === true;
        this.elements?.chatComposer?.classList?.toggle?.('is-attachment-drag-active', isActive);
        const overlay = this.elements?.chatDropOverlay;
        if (overlay) {
            overlay.hidden = !isActive;
            overlay.setAttribute?.('aria-hidden', isActive ? 'false' : 'true');
        }
    }

    setAttachmentUploadBusy(busy) {
        const button = this.elements?.chatAttachmentButton;
        if (!button) return;
        button.disabled = busy === true;
        button.classList.toggle('is-loading', busy === true);
        button.setAttribute('aria-busy', busy === true ? 'true' : 'false');
    }

    publishAttachments(files = [], {boardId = '', position = null} = {}) {
        const nextFiles = Array.from(files || []).filter(Boolean);
        if (!nextFiles.length) return Promise.resolve();
        nextFiles.forEach((file, index) => this.attachmentUploadQueue.push({
            file,
            boardId: String(boardId || '').trim(),
            position: position && Number.isFinite(Number(position.x)) && Number.isFinite(Number(position.y))
                ? {x: Number(position.x) + index * 24, y: Number(position.y) + index * 24}
                : null
        }));
        if (!this.attachmentUploadDrainPromise) {
            this.attachmentUploadDrainPromise = this.drainAttachmentUploadQueue()
                .finally(() => {
                    this.attachmentUploadDrainPromise = null;
                });
        }
        return this.attachmentUploadDrainPromise;
    }

    async drainAttachmentUploadQueue() {
        this.setAttachmentUploadBusy(true);
        try {
            while (this.attachmentUploadQueue.length) {
                const upload = this.attachmentUploadQueue.shift();
                try {
                    await this.publishAttachmentFile(upload.file, upload);
                } catch (error) {
                    this.setError(`Failed to publish file: ${error.message}`);
                }
            }
        } finally {
            this.setAttachmentUploadBusy(false);
        }
    }

    async publishAttachmentFile(file, {boardId: requestedBoardId = '', position = null} = {}) {
        const meeting = this.getSelectedMeeting();
        const session = this.getSession();
        if (!meeting || !session?.participantIdentity) {
            this.setError('Join the meeting before uploading a file.');
            return;
        }
        if (Number(file?.size || 0) > 15 * 1024 * 1024) {
            this.setError('Files may not exceed 15 MB.');
            return;
        }
        try {
            const boardId = requestedBoardId || await this.resolveActiveBoardId(meeting, session);
            if (!boardId) throw new Error('The active Blackboard workspace is unavailable.');
            const upload = await fetch('/blobs/explorer', {
                method: 'POST',
                headers: {
                    'Content-Type': file.type || 'application/octet-stream',
                    'X-Mime-Type': file.type || 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(file.name || 'file')
                },
                body: file
            });
            if (!upload.ok) throw new Error((await upload.text().catch(() => '')) || `File upload failed (${upload.status}).`);
            const staged = await upload.json();
            const result = await this.runTool('webmeet_attachment_publish', {
                roomId: meeting.id,
                boardId,
                participantId: session.participantIdentity,
                blobRef: {
                    id: staged.id,
                    agent: staged.agent,
                    localPath: staged.localPath
                },
                ...(position ? {position} : {})
            });
            if (!result?.message || !result?.blackboard) throw new Error('File publishing returned an incomplete result.');
            const state = this.getState();
            state.chat = Array.isArray(state.chat) ? state.chat : [];
            if (!state.chat.some((entry) => entry?.id === result.message.id)) state.chat.push(result.message);
            try {
                await this.refreshBlackboard(result, { ensureVisible: true });
            } catch (error) {
                this.setError(`File was published, but Blackboard could not be opened: ${error.message}`);
            }
            this.renderFeedLists();
            if (this.getRoom()?.localParticipant) {
                await this.publishRealtimePayload({ type: WEBMEET_EVENT_TYPES.CHAT_REALTIME, meetingId: meeting.id, message: result.message }).catch(() => {});
                await this.publishRealtimePayload({
                    type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
                    meetingId: meeting.id,
                    boardId,
                    blackboardRevision: Number(result.blackboard.revision || 0),
                    changeType: 'create'
                }).catch(() => {});
            }
        } catch (error) {
            this.setError(`Failed to publish file: ${error.message}`);
        }
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
        this.destroyAttachmentUpload();
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
        if (!input) return composer || null;
        return input.closest?.('.webmeet-chat-input-shell') || composer || input.parentElement || null;
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
        let boardId = '';
        const notifyStatus = (state, errorMessage = '') => {
            if (!isRobo || !boardId) return;
            try {
                void Promise.resolve(this.updateRoboCommandStatus({
                    meetingId: meeting.id,
                    boardId,
                    commandId,
                    participantId,
                    state,
                    ...(errorMessage ? { errorMessage } : {})
                })).catch(() => {});
            } catch (_) {}
        };
        try {
            boardId = await this.resolveActiveBoardId(meeting, session);
            if (!boardId) throw new Error('The active Blackboard workspace is unavailable.');
            notifyStatus('started');
            this.elements.chatInput.value = '';
            this.updateComposerMentionOverlay();
            const eventInput = isRobo ? message : message.replace(/^\/event\s*/i, '').trim();
            const result = await this.runTool('webmeet_event_command', {
                roomId: meeting.id,
                boardId,
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
            if (result?.clientAction) await this.executeBlackboardClientAction(result.clientAction);
            if (result?.visibilityPayload || result?.blackboard) {
                await this.refreshBlackboard(result).catch(() => {});
            }
            if (result?.blackboard) {
                if (this.getRoom()?.localParticipant) {
                    await this.publishRealtimePayload({
                        type: WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
                        meetingId: meeting.id,
                        boardId,
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
