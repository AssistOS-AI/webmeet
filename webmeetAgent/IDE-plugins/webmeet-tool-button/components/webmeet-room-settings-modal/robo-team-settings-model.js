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
        name: '',
        mode: 'meeting-assistant',
        instructions: '',
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
        structureInstructions: '',
        toneInstructions: 'technical',
        participantCorrectionsEnabled: false,
        exportRequiresApproval: true
    },
    moderation: {
        enabled: false,
        rules: '',
        speakingOrderEnabled: false,
        speakingTimeLimitEnabled: false,
        speakingTimeLimitMinutes: 5,
        microphoneControlAllowed: false,
        sensitiveActionsRequireApproval: true
    },
    bots: {
        enabled: false,
        allowedRoles: [],
        roleInstructions: '',
        personalityAndObjectives: '',
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
    return result;
}

export function isRoboTeamActive(settings = {}) {
    const sections = ['meetingNotes', 'blackboard', 'documentBuilder', 'moderation', 'bots', 'adaptation'];
    return sections.some((key) => Boolean(settings[key]?.enabled));
}
