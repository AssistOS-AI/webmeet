export const ASSISTANT_MODES = Object.freeze([
    { value: 'meeting-assistant', label: 'Meeting assistant' },
    { value: 'course-assistant', label: 'Course assistant' },
    { value: 'document-assistant', label: 'Document assistant' },
    { value: 'moderator', label: 'Moderator' },
    { value: 'ai-theatre', label: 'AI theatre' }
]);

export const SCENARIO_OPTIONS = Object.freeze([
    { value: 'meeting', label: 'Meeting' },
    { value: 'course', label: 'Course' },
    { value: 'brainstorming', label: 'Brainstorming' },
    { value: 'simulation', label: 'Simulation' },
    { value: 'debate', label: 'Debate' },
    { value: 'skit', label: 'Skit' },
    { value: 'podcast', label: 'Podcast' },
    { value: 'video-production', label: 'Video production' }
]);

export const MEETING_NOTES_SECTIONS = Object.freeze([
    { value: 'ideas', label: 'Important ideas' },
    { value: 'decisions', label: 'Decisions' },
    { value: 'questions', label: 'Questions' },
    { value: 'risks', label: 'Risks' },
    { value: 'actions', label: 'Future actions' },
    { value: 'unresolved', label: 'Unresolved points' }
]);

export const BLACKBOARD_VISIBILITY_OPTIONS = Object.freeze([
    { value: 'organizer-only', label: 'Organizer only' },
    { value: 'all-participants', label: 'All participants' }
]);

export const DOCUMENT_PURPOSE_OPTIONS = Object.freeze([
    { value: 'specification', label: 'Specification' },
    { value: 'proposal', label: 'Proposal' },
    { value: 'report', label: 'Report' },
    { value: 'course-material', label: 'Course material' },
    { value: 'executive-summary', label: 'Executive summary' },
    { value: 'scenario', label: 'Scenario' }
]);

export const DOCUMENT_TONE_OPTIONS = Object.freeze([
    { value: 'technical', label: 'Technical' },
    { value: 'executive', label: 'Executive' },
    { value: 'educational', label: 'Educational' },
    { value: 'narrative', label: 'Narrative' },
    { value: 'concise', label: 'Concise' }
]);

export const BOT_ROLES = Object.freeze([
    { value: 'expert', label: 'Expert' },
    { value: 'critic', label: 'Critic' },
    { value: 'student', label: 'Student' },
    { value: 'moderator', label: 'Moderator' },
    { value: 'actor', label: 'Actor' },
    { value: 'interviewer', label: 'Interviewer' }
]);

export const DEFAULT_ROBO_TEAM_SETTINGS = Object.freeze({
    assistant: {
        name: 'Assistant',
        mode: 'meeting-assistant',
        instructions: 'Help participants follow the room objective, keep the discussion clear, and summarize important points.',
        scenarioOrObjective: 'meeting'
    },
    meetingNotes: {
        enabled: false,
        sections: [],
        visibleDuringMeeting: false,
        reviewEnabled: false,
        exportEnabled: false
    },
    blackboard: {
        enabled: false,
        visibility: 'organizer-only',
        autoUpdateFromConversation: false,
        participantRequestsEnabled: false
    },
    documentBuilder: {
        enabled: false,
        purpose: 'specification',
        structureInstructions: 'Create a clear document with sections, decisions, open questions, and next actions.',
        toneInstructions: 'technical',
        participantCorrectionsEnabled: false,
        exportRequiresApproval: true
    },
    moderation: {
        enabled: false,
        rules: 'Keep the conversation focused, respectful, and on topic.',
        speakingOrderEnabled: false,
        speakingTimeLimitEnabled: false,
        speakingTimeLimitMinutes: 5,
        microphoneControlAllowed: false,
        sensitiveActionsRequireApproval: true
    },
    bots: {
        enabled: false,
        allowedRoles: ['expert'],
        roleInstructions: 'Use the selected roles to support the room objective without interrupting the main discussion.',
        personalityAndObjectives: 'Be helpful, concise, and aligned with the room objective.',
        organizerApprovalRequired: true
    },
    adaptation: {
        enabled: false,
        participantRequestsEnabled: false,
        silenceAsAcceptanceForMinorChanges: false,
        explicitApprovalForSensitiveActions: true
    }
});

export function normalizeRoboTeamSettings(settings) {
    const input = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    const defaults = DEFAULT_ROBO_TEAM_SETTINGS;
    const result = {};
    for (const key of Object.keys(defaults)) {
        const section = input[key] && typeof input[key] === 'object' ? input[key] : {};
        result[key] = { ...defaults[key], ...section };
    }
    for (const key of ['name', 'mode', 'instructions', 'scenarioOrObjective']) {
        if (!String(result.assistant[key] || '').trim()) {
            result.assistant[key] = defaults.assistant[key];
        }
    }
    return result;
}

export function isRoboTeamActive(settings = {}) {
    const sections = ['meetingNotes', 'blackboard', 'documentBuilder', 'moderation', 'bots', 'adaptation'];
    return sections.some((key) => Boolean(settings[key]?.enabled));
}
