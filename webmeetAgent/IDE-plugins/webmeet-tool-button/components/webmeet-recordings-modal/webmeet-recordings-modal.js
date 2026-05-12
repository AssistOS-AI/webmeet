import { runWebMeetTool } from '../../services/webmeet-api-client.js';

export class WebmeetRecordingsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.meetingId = this.element.getAttribute('data-meetingId');
        this.meetingTitle = this.element.getAttribute('data-meetingTitle');
        this.state = {
            recordings: []
        };
        this.invalidate();
    }

    async beforeRender() {
        await this.loadRecordings();
    }

    afterRender() {
        this.recordingList = this.element.querySelector('#webmeetRecordingList');
        this.renderRecordings();
    }

    async loadRecordings() {
        try {
            const payload = await runWebMeetTool('webmeet_artifact_list', { meetingId: this.meetingId });
            this.state.recordings = Array.isArray(payload.recordings) ? payload.recordings : [];
        } catch (error) {
            console.error('Failed to load recordings:', error);
        }
    }

    renderRecordings() {
        if (!this.recordingList) return;
        this.recordingList.innerHTML = this.state.recordings.map(entry => `
            <div class="webmeet-feed-item">
                <div class="webmeet-chat-meta">
                    <span class="webmeet-chat-author">${this.escapeHtml(entry.filename || 'Recording')}</span>
                    <span class="webmeet-chat-time">${new Date(entry.createdAt).toLocaleString()}</span>
                </div>
                <div class="webmeet-chat-text">Status: ${this.escapeHtml(entry.status || 'unknown')}</div>
            </div>
        `).join('') || '<div class="webmeet-chat-empty">No recordings found.</div>';
    }

    escapeHtml(value) {
        return String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    closeModal() {
        assistOS.UI.closeModal(this.element);
    }
}
