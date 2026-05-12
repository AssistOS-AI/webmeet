import { runWebMeetTool } from '../../services/webmeet-api-client.js';

export class WebmeetArtifactsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.meetingId = this.element.getAttribute('data-meetingId');
        this.meetingTitle = this.element.getAttribute('data-meetingTitle');
        this.state = {
            artifacts: []
        };
        this.invalidate();
    }

    async beforeRender() {
        await this.loadArtifacts();
    }

    afterRender() {
        this.artifactList = this.element.querySelector('#webmeetArtifactList');
        this.renderArtifacts();
    }

    async loadArtifacts() {
        try {
            const payload = await runWebMeetTool('webmeet_artifact_list', { meetingId: this.meetingId });
            this.state.artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
        } catch (error) {
            console.error('Failed to load artifacts:', error);
        }
    }

    renderArtifacts() {
        if (!this.artifactList) return;
        this.artifactList.innerHTML = this.state.artifacts.map(entry => `
            <div class="webmeet-feed-item">
                <div class="webmeet-chat-meta">
                    <span class="webmeet-chat-author">${this.escapeHtml(entry.title || 'Untitled Artifact')}</span>
                    <span class="webmeet-chat-time">${new Date(entry.createdAt).toLocaleDateString()}</span>
                </div>
                <div class="webmeet-chat-text">${this.escapeHtml(entry.description || '')}</div>
            </div>
        `).join('') || '<div class="webmeet-chat-empty">No artifacts found.</div>';
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
