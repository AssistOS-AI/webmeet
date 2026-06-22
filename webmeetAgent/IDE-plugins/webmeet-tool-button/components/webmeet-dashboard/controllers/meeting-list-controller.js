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

    render(meetings, selectedMeetingId, meetingParticipantsById, canManageRooms = false, joiningMeetingId = '', showArchivedRooms = false) {
        if (!this.meetingListElement) return;
        const safeMeetings = Array.isArray(meetings) ? meetings : [];
        const activeMeetings = safeMeetings.filter((entry) => !this.isArchivedRoom(entry));
        const archivedMeetings = canManageRooms && showArchivedRooms
            ? safeMeetings.filter((entry) => this.isArchivedRoom(entry))
            : [];
        const activeJoiningId = String(joiningMeetingId || '').trim();
        const activeHtml = activeMeetings.map((entry) => this.renderRoomItem(entry, selectedMeetingId, meetingParticipantsById, canManageRooms, activeJoiningId)).join('');
        const archivedHtml = archivedMeetings.length
            ? `
                <div class="webmeet-room-section-title">Archived rooms</div>
                ${archivedMeetings.map((entry) => this.renderRoomItem(entry, selectedMeetingId, meetingParticipantsById, canManageRooms, activeJoiningId)).join('')}
            `
            : '';
        this.meetingListElement.innerHTML = (activeHtml || archivedHtml)
            ? `${activeHtml}${archivedHtml}`
            : '<div class="webmeet-room-empty">No rooms yet.</div>';
    }

    isArchivedRoom(entry) {
        return String(entry?.status || '').trim().toLowerCase() === 'archived'
            || Boolean(String(entry?.archivedAt || '').trim());
    }

    renderRoomItem(entry, selectedMeetingId, meetingParticipantsById, canManageRooms, activeJoiningId) {
        const isGuestRoom = entry.roomType === 'guest';
        const isArchived = this.isArchivedRoom(entry);
        const isJoining = !isArchived && String(entry.id || '').trim() === activeJoiningId;
        const rowAction = isArchived ? 'selectMeeting' : 'selectAndJoinMeeting';
        return `
            <div class="webmeet-list-item ${entry.id === selectedMeetingId ? 'is-selected' : ''} ${isJoining ? 'is-joining' : ''} ${activeJoiningId ? 'is-join-locked' : ''} ${isArchived ? 'is-archived' : ''}" data-id="${escapeHtml(entry.id)}" aria-busy="${isJoining ? 'true' : 'false'}">
                <div class="webmeet-meeting-row" data-local-action="${rowAction}" data-id="${escapeHtml(entry.id)}">
                    <div class="webmeet-room-identity">
                        <span class="webmeet-room-icon ${isArchived ? 'is-archived' : (isGuestRoom ? 'is-guest' : 'is-team')}" aria-hidden="true" title="${isArchived ? 'Archived room' : (isGuestRoom ? 'Public meeting' : 'Team Room')}">
                            ${this.renderRoomIcon(isGuestRoom, isArchived)}
                        </span>
                        <div class="webmeet-room-copy">
                            <strong class="webmeet-meeting-title">${escapeHtml(entry.title)}</strong>
                            ${isArchived ? '<span class="webmeet-room-archived-label">Archived</span>' : ''}
                        </div>
                    </div>
                    ${isJoining ? '<span class="webmeet-room-join-spinner" aria-hidden="true"></span>' : ''}
                </div>
                ${this.renderRoomActions(entry, canManageRooms, isArchived)}
                ${this.renderMeetingParticipants(meetingParticipantsById, entry.id)}
            </div>
        `;
    }

    renderRoomIcon(isGuestRoom, isArchived) {
        if (isArchived) {
            return `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="3" y="4" width="18" height="5" rx="1"></rect>
                    <path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9"></path>
                    <path d="M10 13h4"></path>
                </svg>
            `;
        }
        if (isGuestRoom) {
            return `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                    <polyline points="15 3 21 3 21 9"></polyline>
                    <line x1="10" y1="14" x2="21" y2="3"></line>
                </svg>
            `;
        }
        return `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                <circle cx="9" cy="7" r="4"></circle>
                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
        `;
    }

    renderRoomActions(entry, canManageRooms, isArchived) {
        if (isArchived) return '';
        const actionName = canManageRooms ? 'openRoomSettings' : 'copyRoomLink';
        const actionLabel = canManageRooms ? 'Room settings' : 'Copy room link';
        return `
            <div class="webmeet-room-actions" aria-label="Room actions">
                <button type="button" class="webmeet-room-action-button" data-local-action="${actionName}" data-id="${escapeHtml(entry.id)}" title="${actionLabel}" aria-label="${actionLabel}">
                    ${canManageRooms ? `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <circle cx="12" cy="12" r="3"></circle>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 5 15a1.65 1.65 0 0 0-1.51-1H3.4a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5 8a1.65 1.65 0 0 0-.33-1.82l-.06-.06A2 2 0 1 1 7.44 3.3l.06.06A1.65 1.65 0 0 0 9.32 3a1.65 1.65 0 0 0 1-1.51V1.4a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8a1.65 1.65 0 0 0 1.51 1h.09a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19 15z"></path>
                        </svg>
                    ` : `
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                        </svg>
                    `}
                </button>
            </div>
        `;
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
                ${participants.map((participant, index) => {
                    const micState = participant.micOn === true ? 'on' : participant.micOn === false ? 'off' : 'unknown';
                    const isSpeaking = participant.isSpeaking === true;
                    const micTitle = micState === 'on'
                        ? 'Microphone on'
                        : micState === 'off'
                            ? 'Microphone off'
                            : 'Microphone status syncing';
                    const micIcon = micState === 'off'
                        ? `
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <line x1="1" y1="1" x2="23" y2="23"></line>
                                    <path d="M9 9v6a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.18"></path>
                                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            `
                        : `
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                                    <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                                    <line x1="12" y1="19" x2="12" y2="23"></line>
                                    <line x1="8" y1="23" x2="16" y2="23"></line>
                                </svg>
                            `;
                    const speakingIcon = `
                        <span class="webmeet-room-participant-speaking ${isSpeaking ? '' : 'is-idle'}" ${isSpeaking ? 'title="Speaking" aria-label="Speaking"' : 'aria-hidden="true"'}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <path d="M4 14v-4"></path>
                                <path d="M8 18V6"></path>
                                <path d="M12 21V3"></path>
                                <path d="M16 18V6"></path>
                                <path d="M20 14v-4"></path>
                            </svg>
                        </span>
                    `;
                    const participantClasses = [
                        'webmeet-room-participant',
                        index === participants.length - 1 ? 'is-last' : '',
                        isSpeaking ? 'is-speaking' : ''
                    ].filter(Boolean).join(' ');
                    return `
                    <div class="${participantClasses}">
                        ${speakingIcon}
                        <span class="webmeet-room-participant-mic is-${micState}" title="${micTitle}" aria-label="${micTitle}">
                            ${micIcon}
                        </span>
                        <span class="webmeet-room-participant-name">${escapeHtml(participant.name || 'Participant')}</span>
                        ${participant.isAgent ? '<span class="webmeet-room-participant-badge">AI</span>' : ''}
                    </div>
                `;
                }).join('')}
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
