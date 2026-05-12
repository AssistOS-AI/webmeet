function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

export class MeetingListController {
    constructor() {
        this.meetingListElement = null;
    }

    setElement(element) {
        this.meetingListElement = element || null;
    }

    render(meetings, selectedMeetingId, meetingParticipantsById, canManageRooms = false, joiningMeetingId = '') {
        if (!this.meetingListElement) return;
        const safeMeetings = Array.isArray(meetings) ? meetings : [];
        const activeJoiningId = String(joiningMeetingId || '').trim();
        this.meetingListElement.innerHTML = safeMeetings.map((entry) => {
            const isGuestRoom = entry.roomType === 'guest';
            const isJoining = String(entry.id || '').trim() === activeJoiningId;
            return `
            <div class="webmeet-list-item ${entry.id === selectedMeetingId ? 'is-selected' : ''} ${isJoining ? 'is-joining' : ''} ${activeJoiningId ? 'is-join-locked' : ''}" data-id="${escapeHtml(entry.id)}" aria-busy="${isJoining ? 'true' : 'false'}">
                <div class="webmeet-meeting-row" data-local-action="selectAndJoinMeeting" data-id="${escapeHtml(entry.id)}">
                    <div class="webmeet-room-identity">
                        <span class="webmeet-room-icon ${isGuestRoom ? 'is-guest' : 'is-team'}" aria-hidden="true" title="${isGuestRoom ? 'Guest Room' : 'Team Room'}">
                            ${isGuestRoom ? `
                                <!-- Guest Room Icon - External Link -->
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                    <polyline points="15 3 21 3 21 9"></polyline>
                                    <line x1="10" y1="14" x2="21" y2="3"></line>
                                </svg>
                            ` : `
                                <!-- Team Room Icon - Users/People -->
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="9" cy="7" r="4"></circle>
                                    <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                    <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                                </svg>
                            `}
                        </span>
                        <div class="webmeet-room-copy">
                            <strong class="webmeet-meeting-title">${escapeHtml(entry.title)}</strong>
                        </div>
                    </div>
                    ${isJoining ? '<span class="webmeet-room-join-spinner" aria-hidden="true"></span>' : ''}
                </div>
                <div class="webmeet-room-actions" aria-label="Room actions">
                    ${canManageRooms ? `
                        ${isGuestRoom ? `
                            <button type="button" class="webmeet-room-action-button" data-local-action="copyGuestInviteLink" data-id="${escapeHtml(entry.id)}" title="Copy invite link" aria-label="Copy invite link">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                                </svg>
                            </button>
                        ` : ''}
                        <button type="button" class="webmeet-room-action-button" data-local-action="renameMeeting" data-id="${escapeHtml(entry.id)}" title="Rename room" aria-label="Rename room">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M12 20h9"></path>
                                <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"></path>
                            </svg>
                        </button>
                        <button type="button" class="webmeet-room-action-button danger" data-local-action="deleteMeeting" data-id="${escapeHtml(entry.id)}" title="Delete room" aria-label="Delete room">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M3 6h18"></path>
                                <path d="M8 6V4h8v2"></path>
                                <path d="M19 6l-1 14H6L5 6"></path>
                                <path d="M10 11v5"></path>
                                <path d="M14 11v5"></path>
                            </svg>
                        </button>
                        <button type="button" class="webmeet-room-action-button" data-local-action="showRoomAiMenu" data-id="${escapeHtml(entry.id)}" title="AI & Insights" aria-label="AI & Insights">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"></path>
                                <path d="m5 3 1 1"></path>
                                <path d="m19 17 1 1"></path>
                                <path d="m19 3 1 1"></path>
                                <path d="m5 17 1 1"></path>
                            </svg>
                        </button>` : ''}
                </div>
                ${this.renderMeetingParticipants(meetingParticipantsById, entry.id)}
            </div>
        `;}).join('') || '<div class="webmeet-room-empty">No rooms yet.</div>';
    }

    renderMeetingParticipants(meetingParticipantsById, meetingId) {
        const participants = Array.isArray(meetingParticipantsById?.[meetingId])
            ? meetingParticipantsById[meetingId]
            : [];
        if (!participants.length) {
            return  `<div class="webmeet-room-participants"> No participants </div>`;
        }
        return `
            <div class="webmeet-room-participants">
                ${participants.map((participant, index) => `
                    <div class="webmeet-room-participant ${index === participants.length - 1 ? 'is-last' : ''}">
                        <span class="webmeet-room-participant-mic ${participant.micOn ? 'is-on' : 'is-off'}" title="${participant.micOn ? 'Microphone on' : 'Microphone off'}" aria-label="${participant.micOn ? 'Microphone on' : 'Microphone off'}">
                            ${participant.micOn ? `
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            ` : `
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <line x1="1" y1="1" x2="23" y2="23"></line>
                                    <path d="M9 9v6a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.18"></path>
                                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            `}
                        </span>
                        <span class="webmeet-room-participant-name">${escapeHtml(participant.name || 'Participant')}</span>
                        ${participant.isAgent ? '<span class="webmeet-room-participant-badge">AI</span>' : ''}
                    </div>
                `).join('')}
            </div>
        `;
    }

    removeParticipantFromMeetingMap(meetingParticipantsById, meetingId, participantId) {
        const targetMeetingId = String(meetingId || '').trim();
        const targetParticipantId = String(participantId || '').trim();
        if (!targetMeetingId || !targetParticipantId) return;
        const current = Array.isArray(meetingParticipantsById?.[targetMeetingId])
            ? meetingParticipantsById[targetMeetingId]
            : [];
        meetingParticipantsById[targetMeetingId] = current.filter((entry) => (
            String(entry?.id || '').trim() !== targetParticipantId
        ));
    }
}
