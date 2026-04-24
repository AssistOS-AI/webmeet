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

    render(meetings, selectedMeetingId, meetingParticipantsById) {
        if (!this.meetingListElement) return;
        const safeMeetings = Array.isArray(meetings) ? meetings : [];
        this.meetingListElement.innerHTML = safeMeetings.map((entry) => `
            <div class="webmeet-list-item ${entry.id === selectedMeetingId ? 'is-selected' : ''}" data-local-action="selectAndJoinMeeting" data-id="${escapeHtml(entry.id)}">
                <div class="webmeet-meeting-row">
                    <span class="webmeet-room-icon" aria-hidden="true">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <rect x="3" y="6" width="14" height="12" rx="2" ry="2"></rect>
                            <polygon points="17 10 22 7 22 17 17 14"></polygon>
                        </svg>
                    </span>
                    <strong class="webmeet-meeting-title">${escapeHtml(entry.title)}</strong>
                    <span class="webmeet-meeting-status ${entry.id === selectedMeetingId ? '' : 'webmeet-hidden'}">${escapeHtml(entry.status)}</span>
                </div>
                ${this.renderMeetingParticipants(meetingParticipantsById, entry.id)}
            </div>
        `).join('') || '<div class="webmeet-room-empty">No rooms yet.</div>';
    }

    renderMeetingParticipants(meetingParticipantsById, meetingId) {
        const participants = Array.isArray(meetingParticipantsById?.[meetingId])
            ? meetingParticipantsById[meetingId]
            : [];
        if (!participants.length) {
            return '';
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
