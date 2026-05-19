import { runWebMeetTool } from '../../services/webmeet-api-client.js';

export class WebmeetTranscriptModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.meetingId = this.element.getAttribute('data-meetingId');
        this.meetingTitle = this.element.getAttribute('data-meetingTitle');

        this.state = {
            transcript: []
        };
        this.refreshTimer = null;

        this.invalidate();
    }

    async beforeRender() {
        await this.loadTranscript();
    }

    afterRender() {
        this.transcriptList = this.element.querySelector('#webmeetTranscriptList');
        this.renderTranscript();
        this.startAutoRefresh();
    }

    async loadTranscript() {
        try {
            const payload = await runWebMeetTool('webmeet_transcript_list', { meetingId: this.meetingId });
            this.state.transcript = Array.isArray(payload.transcript) ? payload.transcript : [];
        } catch (error) {
            console.error('Failed to load transcript:', error);
        }
    }

    renderTranscript() {
        if (!this.transcriptList) return;
        const groups = this.groupTranscriptByDay();
        this.transcriptList.innerHTML = groups.map(group => `
            <section class="webmeet-transcript-day">
                <h3 class="webmeet-transcript-day-title">${this.escapeHtml(group.label)}</h3>
                ${group.items.map(entry => `
                    <div class="webmeet-feed-item">
                        <div class="webmeet-chat-meta">
                            <span class="webmeet-chat-author">${this.escapeHtml(entry.speakerName || entry.speakerId || 'Participant')}</span>
                            <span class="webmeet-chat-time">${this.escapeHtml(this.formatTime(entry.startedAt || entry.createdAt))}</span>
                        </div>
                        <div class="webmeet-chat-text">${this.escapeHtml(entry.text)}</div>
                    </div>
                `).join('')}
            </section>
        `).join('') || '<div class="webmeet-chat-empty">No transcript yet.</div>';
    }

    startAutoRefresh() {
        this.stopAutoRefresh();
        this.refreshTimer = window.setInterval(() => {
            void (async () => {
                await this.loadTranscript();
                this.renderTranscript();
            })();
        }, 4000);
    }

    stopAutoRefresh() {
        if (!this.refreshTimer) return;
        window.clearInterval(this.refreshTimer);
        this.refreshTimer = null;
    }

    groupTranscriptByDay() {
        const items = Array.isArray(this.state.transcript) ? [...this.state.transcript] : [];
        items.sort((a, b) => (Date.parse(a.startedAt || a.createdAt || '') || 0) - (Date.parse(b.startedAt || b.createdAt || '') || 0));
        const groups = [];
        const byKey = new Map();
        for (const item of items) {
            const date = new Date(item.startedAt || item.createdAt || Date.now());
            const key = Number.isNaN(date.getTime()) ? 'unknown' : date.toISOString().slice(0, 10);
            if (!byKey.has(key)) {
                const group = { key, label: key === 'unknown' ? 'Unknown date' : date.toLocaleDateString(), items: [] };
                byKey.set(key, group);
                groups.push(group);
            }
            byKey.get(key).items.push(item);
        }
        return groups;
    }

    formatTime(value) {
        const date = new Date(value || Date.now());
        if (Number.isNaN(date.getTime())) return '--:--';
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    downloadTranscript() {
        const url = new URL(`/services/webmeet/meetings/${encodeURIComponent(this.meetingId)}/transcript/download`, window.location.origin);
        url.searchParams.set('format', 'md');
        window.open(url.toString(), '_blank', 'noopener');
    }

    escapeHtml(value) {
        return String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    closeModal() {
        this.stopAutoRefresh();
        assistOS.UI.closeModal(this.element);
    }
}
