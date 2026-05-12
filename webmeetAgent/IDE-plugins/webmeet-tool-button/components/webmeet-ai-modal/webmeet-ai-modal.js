import { runWebMeetTool } from '../../services/webmeet-api-client.js';

const AGENT_ROWS = [
    {
        title: 'Observer',
        agentType: 'observer',
        mode: 'passive',
        summary: 'Observes the room context.'
    },
    {
        title: 'Assistant',
        agentType: 'assistant_on_mention',
        mode: 'on_mention',
        summary: 'Responds when mentioned directly.'
    },
    {
        title: 'Scribe',
        agentType: 'scribe',
        mode: 'post_event',
        summary: 'Prepares post-event meeting outputs.'
    }
];

export class WebmeetAiModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.meetingId = this.element.getAttribute('data-meetingId');
        this.meetingTitle = this.element.getAttribute('data-meetingTitle');
        this.state = {
            agents: []
        };
        this.invalidate();
    }

    async beforeRender() {
        await this.loadAgents();
    }

    afterRender() {
        this.agentList = this.element.querySelector('#webmeetAgentList');
        this.renderAgents();
    }

    async loadAgents() {
        try {
            const payload = await runWebMeetTool('webmeet_agent_list', { meetingId: this.meetingId });
            this.state.agents = Array.isArray(payload.agents) ? payload.agents : [];
        } catch (error) {
            console.error('Failed to load agents:', error);
        }
    }

    renderAgents() {
        if (!this.agentList) return;
        this.agentList.innerHTML = AGENT_ROWS.map((definition) => {
            const currentAgent = this.getAgentForDefinition(definition);
            const isActive = this.isActiveAgent(currentAgent);
            const status = currentAgent?.status || (currentAgent ? 'stopped' : 'not attached');
            return `
            <div class="webmeet-feed-item webmeet-agent-row" data-agent-type="${this.escapeHtml(definition.agentType)}" data-agent-mode="${this.escapeHtml(definition.mode)}">
                <div class="webmeet-agent-row-main">
                    <div class="webmeet-chat-meta">
                        <span class="webmeet-chat-author">${this.escapeHtml(definition.title)}</span>
                        <span class="webmeet-agent-status ${isActive ? 'is-active' : 'is-idle'}">${this.escapeHtml(status)}</span>
                    </div>
                    <div class="webmeet-chat-text">${this.escapeHtml(definition.summary)}</div>
                    <div class="webmeet-agent-mode">Mode: ${this.escapeHtml(definition.mode)}</div>
                </div>
                ${isActive ? `
                    <button type="button" class="general-button subtle-button" data-local-action="detachAgent" data-agent-id="${this.escapeHtml(currentAgent.id || '')}">
                        Disable
                    </button>
                ` : `
                    <button type="button" class="general-button subtle-button" data-local-action="attachAgentFromRow" data-agent-type="${this.escapeHtml(definition.agentType)}" data-agent-mode="${this.escapeHtml(definition.mode)}">
                        Attach
                    </button>
                `}
            </div>
        `;
        }).join('');
    }

    getAgentForDefinition(definition) {
        const agentType = String(definition?.agentType || '').trim();
        const mode = String(definition?.mode || '').trim();
        const matches = Array.isArray(this.state.agents)
            ? this.state.agents.filter((entry) => (
                String(entry?.agentType || '').trim() === agentType
                && String(entry?.mode || '').trim() === mode
            ))
            : [];
        return matches.find((entry) => this.isActiveAgent(entry)) || matches.at(-1) || null;
    }

    isActiveAgent(entry) {
        return Boolean(entry && entry.id && !entry.deletedAt && String(entry.status || '').trim() !== 'stopped');
    }

    escapeHtml(value) {
        return String(value || '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;');
    }

    async attachAgent(agentType, mode) {
        try {
            await runWebMeetTool('webmeet_agent_attach', { meetingId: this.meetingId, agentType, mode });
            await this.loadAgents();
            this.renderAgents();
        } catch (error) {
            console.error('Failed to attach agent:', error);
        }
    }

    async attachObserver() { await this.attachAgent('observer', 'passive'); }
    async attachAssistant() { await this.attachAgent('assistant_on_mention', 'on_mention'); }
    async attachScribe() { await this.attachAgent('scribe', 'post_event'); }

    async attachAgentFromRow(target) {
        const source = target?.target || target;
        const agentType = String(source?.dataset?.agentType || '').trim();
        const mode = String(source?.dataset?.agentMode || '').trim();
        if (!agentType || !mode) return;
        await this.attachAgent(agentType, mode);
    }

    async detachAgent(target) {
        const source = target?.target || target;
        const agentId = String(source?.dataset?.agentId || '').trim();
        if (!agentId) return;
        try {
            await runWebMeetTool('webmeet_agent_detach', { meetingId: this.meetingId, agentId });
            await this.loadAgents();
            this.renderAgents();
        } catch (error) {
            console.error('Failed to detach agent:', error);
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element);
    }
}
