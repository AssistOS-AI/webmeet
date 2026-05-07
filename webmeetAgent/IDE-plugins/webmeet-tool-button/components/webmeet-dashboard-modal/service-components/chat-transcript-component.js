import { runWebMeetTool } from '../services/webmeet-api-client.js';

const runTool = runWebMeetTool;

/**
 * ChatTranscriptComponent - Manages chat, transcript, artifacts, and recordings
 * Extracted from webmeet-dashboard-modal.js for better maintainability
 */
export class ChatTranscriptComponent {
    constructor(options = {}) {
        this.isGuestSession = options.isGuestSession || (() => false);
        this.sendPublicChat = options.sendPublicChat;
        this.callPublicGuestApi = options.callPublicGuestApi;
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

        this.speechRecognition = null;
        this.elements = {};
    }

    setElements(elements) {
        this.elements = elements;
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

        await runTool('webmeet_chat_send', {
            meetingId: meeting.id,
            authorId: session.participantIdentity,
            authorName: session.participant?.displayName || 'User',
            message
        });
        this.elements.chatInput.value = '';

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

        if (this.isGuestSession()) {
            await this.callPublicGuestApi(meeting.id, 'guest-transcript', { text });
            this.elements.transcriptInput.value = '';
            await this.loadMeetingDetails();
            this.requestRenderAll();
            return;
        }

        await runTool('webmeet_transcript_append', {
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

            if (this.isGuestSession()) {
                await this.callPublicGuestApi(meeting.id, 'guest-transcript', { text });
                await this.loadMeetingDetails();
                this.requestRenderAll();
                return;
            }

            const session = this.getSession();
            await runTool('webmeet_transcript_append', {
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
