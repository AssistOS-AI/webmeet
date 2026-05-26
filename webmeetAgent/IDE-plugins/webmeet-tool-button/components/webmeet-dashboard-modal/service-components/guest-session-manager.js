import {
    buildPublicWebMeetApiBaseUrl,
    readGuestInviteTokenFromUrl
} from '../services/dashboard-utils.js';

/**
 * GuestSessionManager - Manages guest session lifecycle and public API calls
 * Extracted from webmeet-dashboard-modal.js for better maintainability
 */
export class GuestSessionManager {
    constructor(options = {}) {
        this.getState = options.getState || (() => ({}));
        this.setState = options.setState || (() => {});
        this.getSession = options.getSession || (() => null);
        this.setSession = options.setSession || (() => {});
        this.setError = options.setError || console.error;
        this.loadParticipantsForMeetings = options.loadParticipantsForMeetings || (() => Promise.resolve());
        this.loadMeetingDetails = options.loadMeetingDetails || (() => Promise.resolve());
        this.renderAll = options.renderAll || (() => {});
        this.connectRoom = options.connectRoom || (() => Promise.resolve());
        this.hostContext = options.hostContext || {};

        this.elements = {};
    }

    setElements(elements) {
        this.elements = elements;
    }

    isGuestSession() {
        const session = this.getSession();
        return session?.guest === true || Boolean(session?.publicApiBaseUrl);
    }

    getGuestToken() {
        const session = this.getSession();
        return String(
            session?.guestToken
            || session?.meeting?.guestToken
            || readGuestInviteTokenFromUrl()
            || ''
        ).trim();
    }

    async bootstrapGuestSession(session) {
        const meeting = session.meeting || {};
        const publicApiBaseUrl = String(session.publicApiBaseUrl || buildPublicWebMeetApiBaseUrl()).trim();

        this.setState({
            workspaces: [{
                id: meeting.workspaceId || '',
                name: 'WebMeet',
                rootPath: ''
            }],
            meetings: [meeting],
            selectedWorkspaceId: meeting.workspaceId || '',
            selectedMeetingId: meeting.id || '',
            canManageRooms: false,
            session: {
                ...session,
                meeting: meeting,
                participantToken: session.participantToken,
                guestToken: session.guestToken,
                participantIdentity: session.participantIdentity,
                livekitUrl: session.livekitUrl,
                participant: session.participant,
                publicApiBaseUrl,
                guest: true
            }
        });

        this.renderAll();
        await this.loadParticipantsForMeetings();
        await this.loadMeetingDetails();
        this.setState({
            skipConnectedAvatarRepublishOnce: true
        });
        await this.connectRoom();
    }

    async callPublicGuestApi(meetingId, action, payload = {}) {
        const session = this.getSession();
        const baseUrl = String(session?.publicApiBaseUrl || buildPublicWebMeetApiBaseUrl()).trim();
        const url = new URL(`${baseUrl}/meetings/${encodeURIComponent(meetingId)}/${action}`);
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                guestToken: this.getGuestToken(),
                participantId: String(
                    session?.participantIdentity
                    || session?.participant?.id
                    || ''
                ).trim(),
                ...payload
            })
        });
        if (!response.ok) {
            const text = await response.text().catch(() => 'Unknown error');
            throw new Error(`Guest API error: ${response.status} - ${text}`);
        }
        return response.json();
    }

}
