import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class HolisticMeetingNotesAnalyzer {
    constructor(options = {}) {
        this.MainAgent = options.MainAgent || null;
        this.agent = null;
    }

    async getAgent() {
        if (this.agent) return this.agent;
        const MainAgent = this.MainAgent || (await import('achillesAgentLib/MainAgent')).MainAgent;
        this.agent = new MainAgent({ startDir: AGENT_ROOT, disableInternalSkills: true });
        return this.agent;
    }

    async analyze({
        journal, newSegmentIds = [], currentMarkdown = '', participants, structurePrompt,
        discussionMemory = '', compactedSegmentCount = 0,
    }) {
        const agent = await this.getAgent();
        const response = await agent.executeSkill('meeting-notes', JSON.stringify({
            task: 'reconcile-complete-meeting-document',
            journal,
            newSegmentIds,
            currentMarkdown,
            participants,
            structurePrompt,
            discussionMemory,
            compactedSegmentCount: Number(compactedSegmentCount || 0),
        }), {
            context: {
                journal, newSegmentIds, currentMarkdown, participants, structurePrompt,
                discussionMemory,
                compactedSegmentCount: Number(compactedSegmentCount || 0),
            },
        });
        return String(response?.result ?? response?.content ?? response ?? '').trim();
    }

    async compact({ previousMemory, segments, currentMarkdown = '', participants }) {
        const agent = await this.getAgent();
        const context = { previousMemory, segments, currentMarkdown, participants };
        const response = await agent.executeSkill('meeting-memory', JSON.stringify(context), { context });
        const result = response?.result ?? response;
        const parsed = typeof result === 'string' ? JSON.parse(result) : result;
        return String(parsed?.memory || '').trim();
    }

    shutdown() {
        this.agent?.shutdown?.();
        this.agent = null;
    }
}
