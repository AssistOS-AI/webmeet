import {
    assertAdminAuthInfo,
    canViewMeetingRecord
} from '../store/accessPolicy.mjs';
import {
    decryptRoomPayload,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import { Blackboard } from '../blackboard/model.mjs';
import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

export const ROBO_TEAM_AGENT_TYPE = 'robo_team';
export const ROBO_TEAM_MODE = 'blackboard_demo';
export const ROBO_TEAM_PARTICIPANT_ID = 'agent_robo_team';
export const ROBO_TEAM_BLACKBOARD_BOARD_ID = `agent:${ROBO_TEAM_PARTICIPANT_ID}`;

export const DEFAULT_ROBO_TEAM_SETTINGS = Object.freeze({
    assistant: {
        name: 'Robo Team',
        mode: 'meeting-assistant',
        instructions: 'Help participants follow the room objective, keep the discussion clear, and maintain the shared blackboard.',
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
        enabled: true,
        visibility: 'all-participants',
        autoUpdateFromConversation: true,
        participantRequestsEnabled: true
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

function nowIso() {
    return new Date().toISOString();
}

function cloneJson(value) {
    if (value === undefined || value === null) return value;
    return JSON.parse(JSON.stringify(value));
}

function stringifyStableJson(value) {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stringifyStableJson(entry)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map((key) => (
            `${JSON.stringify(key)}:${stringifyStableJson(value[key])}`
        )).join(',')}}`;
    }
    return JSON.stringify(value);
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeRoboTeamSettings(settings = {}) {
    const input = isPlainObject(settings) ? settings : {};
    const output = {};
    for (const [sectionName, defaults] of Object.entries(DEFAULT_ROBO_TEAM_SETTINGS)) {
        const section = isPlainObject(input[sectionName]) ? input[sectionName] : {};
        output[sectionName] = { ...cloneJson(defaults), ...cloneJson(section) };
    }
    output.assistant.name = String(output.assistant.name || DEFAULT_ROBO_TEAM_SETTINGS.assistant.name).trim()
        || DEFAULT_ROBO_TEAM_SETTINGS.assistant.name;
    output.assistant.mode = String(output.assistant.mode || DEFAULT_ROBO_TEAM_SETTINGS.assistant.mode).trim()
        || DEFAULT_ROBO_TEAM_SETTINGS.assistant.mode;
    output.assistant.instructions = String(output.assistant.instructions || DEFAULT_ROBO_TEAM_SETTINGS.assistant.instructions).trim()
        || DEFAULT_ROBO_TEAM_SETTINGS.assistant.instructions;
    output.assistant.scenarioOrObjective = String(output.assistant.scenarioOrObjective || DEFAULT_ROBO_TEAM_SETTINGS.assistant.scenarioOrObjective).trim()
        || DEFAULT_ROBO_TEAM_SETTINGS.assistant.scenarioOrObjective;
    output.blackboard.visibility = String(output.blackboard.visibility || DEFAULT_ROBO_TEAM_SETTINGS.blackboard.visibility).trim()
        || DEFAULT_ROBO_TEAM_SETTINGS.blackboard.visibility;
    return output;
}

export function isRoboTeamEnabled(settings = {}) {
    const normalized = normalizeRoboTeamSettings(settings);
    return Boolean(normalized.blackboard.enabled)
        || Boolean(normalized.meetingNotes.enabled)
        || Boolean(normalized.documentBuilder.enabled)
        || Boolean(normalized.moderation.enabled)
        || Boolean(normalized.bots.enabled)
        || Boolean(normalized.adaptation.enabled);
}

export function ensureRoboTeamSettingsPayload(payload) {
    payload.roboTeamSettings = normalizeRoboTeamSettings(payload.roboTeamSettings);
    return payload.roboTeamSettings;
}

function createRoboTeamBlackboard(roomId = '') {
    const targetRoomId = String(roomId || '').trim();
    return new Blackboard({
        id: `blackboard_${ROBO_TEAM_PARTICIPANT_ID}${targetRoomId ? `_${targetRoomId}` : ''}`,
        roomId: targetRoomId,
        boardId: ROBO_TEAM_BLACKBOARD_BOARD_ID,
        boardOwnerType: 'agent',
        boardOwnerId: ROBO_TEAM_PARTICIPANT_ID,
        boardVisibility: 'room',
        metadata: {
            boardId: ROBO_TEAM_BLACKBOARD_BOARD_ID,
            boardOwnerType: 'agent',
            boardOwnerId: ROBO_TEAM_PARTICIPANT_ID,
            boardVisibility: 'room'
        }
    }).serializePrivileged();
}

function requireRoboTeamBlackboardField(blackboard = {}, fieldName = '') {
    const value = String(blackboard?.[fieldName] || '').trim();
    if (!value) {
        throw new Error(`Invalid RoboTeam blackboard: missing ${fieldName}.`);
    }
    return value;
}

function normalizeRoboTeamBlackboardPayload(blackboard = {}, roomId = '') {
    const targetRoomId = String(roomId || blackboard?.roomId || '').trim();
    const boardId = requireRoboTeamBlackboardField(blackboard, 'boardId');
    const boardOwnerType = requireRoboTeamBlackboardField(blackboard, 'boardOwnerType');
    const boardOwnerId = requireRoboTeamBlackboardField(blackboard, 'boardOwnerId');
    const boardVisibility = requireRoboTeamBlackboardField(blackboard, 'boardVisibility');
    const metadata = blackboard?.metadata && typeof blackboard.metadata === 'object'
        ? cloneJson(blackboard.metadata)
        : {};
    return {
        ...cloneJson(blackboard),
        roomId: targetRoomId,
        boardId,
        boardOwnerType,
        boardOwnerId,
        boardVisibility,
        metadata: {
            ...metadata,
            boardId,
            boardOwnerType,
            boardOwnerId,
            boardVisibility
        }
    };
}

export function getRoboTeamAgentPayload(payload) {
    const agents = Array.isArray(payload?.agents) ? payload.agents : [];
    return agents.find((entry) => String(entry?.agentType || '').trim() === ROBO_TEAM_AGENT_TYPE)
        || agents.find((entry) => String(entry?.id || '').trim() === ROBO_TEAM_PARTICIPANT_ID)
        || null;
}

export function ensureRoboTeamBlackboardPayload(agent, roomId = '') {
    if (!agent || typeof agent !== 'object') {
        throw new Error('RoboTeam agent is required for blackboard access.');
    }
    if (!agent.blackboard || typeof agent.blackboard !== 'object') {
        agent.blackboard = createRoboTeamBlackboard(roomId);
    }
    agent.blackboard = normalizeRoboTeamBlackboardPayload(agent.blackboard, roomId);
    return agent.blackboard;
}

export function getRoboTeamBlackboardRevision(payload) {
    const agent = getRoboTeamAgentPayload(payload);
    return Number(agent?.blackboard?.revision || 0);
}

function buildRoboTeamAgent(settings = {}, previous = {}, meetingId = '') {
    const timestamp = nowIso();
    const blackboard = previous?.blackboard && typeof previous.blackboard === 'object'
        ? normalizeRoboTeamBlackboardPayload(previous.blackboard, meetingId)
        : createRoboTeamBlackboard(meetingId);
    return {
        ...(previous && typeof previous === 'object' ? previous : {}),
        id: String(previous?.id || ROBO_TEAM_PARTICIPANT_ID).trim() || ROBO_TEAM_PARTICIPANT_ID,
        participantIdentity: ROBO_TEAM_PARTICIPANT_ID,
        agentType: ROBO_TEAM_AGENT_TYPE,
        mode: ROBO_TEAM_MODE,
        agentName: String(settings.assistant?.name || 'Robo Team').trim() || 'Robo Team',
        runtime: 'ploinky',
        status: isRoboTeamEnabled(settings) ? 'active' : 'detached',
        createdAt: previous?.createdAt || timestamp,
        updatedAt: timestamp,
        deletedAt: isRoboTeamEnabled(settings) ? null : (previous?.deletedAt || timestamp),
        settings: {
            blackboard: cloneJson(settings.blackboard)
        },
        blackboard
    };
}

export function ensureRoboTeamAgentPayload(payload, stageEvent = null, meetingId = '') {
    const settings = ensureRoboTeamSettingsPayload(payload);
    if (!Array.isArray(payload.agents)) {
        payload.agents = [];
    }
    const existing = payload.agents.find((entry) => String(entry?.agentType || '').trim() === ROBO_TEAM_AGENT_TYPE)
        || payload.agents.find((entry) => String(entry?.id || '').trim() === ROBO_TEAM_PARTICIPANT_ID)
        || null;
    const nextAgent = buildRoboTeamAgent(settings, existing || {}, meetingId);
    if (existing) {
        const nextAgentWithExistingTimestamp = {
            ...nextAgent,
            updatedAt: existing.updatedAt
        };
        if (stringifyStableJson(existing) === stringifyStableJson(nextAgentWithExistingTimestamp)) {
            return existing;
        }
        Object.assign(existing, nextAgent);
    } else {
        payload.agents.push(nextAgent);
        if (stageEvent && isRoboTeamEnabled(settings)) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
                meetingId,
                agentId: nextAgent.id,
                agentType: ROBO_TEAM_AGENT_TYPE,
                mode: ROBO_TEAM_MODE,
                runtime: 'ploinky'
            });
        }
    }
    return existing || nextAgent;
}

function addWidgetIfMissing(blackboard, widget) {
    if (blackboard.getWidget(widget.id)) return;
    blackboard.applyFinalChange({
        changeType: 'create',
        targetType: 'widget',
        widget,
        participantId: ROBO_TEAM_PARTICIPANT_ID,
        reason: 'robo_team_demo'
    });
}

export function ensureRoboTeamDemoBlackboard(payload, roomId) {
    const settings = ensureRoboTeamSettingsPayload(payload);
    if (!isRoboTeamEnabled(settings) || !settings.blackboard.enabled || payload.roboTeamDemoCreated === true) {
        return false;
    }
    const agent = ensureRoboTeamAgentPayload(payload, null, roomId);
    const blackboard = Blackboard.from({
        ...ensureRoboTeamBlackboardPayload(agent, roomId),
        roomId
    });
    if (blackboard.widgets.length > 0) {
        payload.roboTeamDemoCreated = true;
        agent.blackboard = blackboard.serializePrivileged();
        return false;
    }
    addWidgetIfMissing(blackboard, {
        id: 'robo_demo_title',
        type: 'text',
        properties: {
            text: 'Robo Team Blackboard',
            geometry: { x: 48, y: 42, width: 360, height: 58 },
            style: { fontSize: 26, fontWeight: 700, color: '#111827' }
        },
        visibility: 'all'
    });
    addWidgetIfMissing(blackboard, {
        id: 'robo_demo_context',
        type: 'card',
        properties: {
            title: 'Meeting context',
            text: 'RoboTeam can add final-state widgets here from the room conversation.',
            geometry: { x: 48, y: 124, width: 360, height: 140 },
            style: { background: '#f8fafc', borderColor: '#cbd5e1', color: '#1f2937' }
        },
        visibility: 'all'
    });
    addWidgetIfMissing(blackboard, {
        id: 'robo_demo_poll',
        type: 'poll',
        properties: {
            question: 'Ready to proceed?',
            options: ['Yes', 'Need discussion'],
            resultsVisibility: 'public',
            participantData: {},
            aggregation: { resultsVisibility: 'public' },
            geometry: { x: 456, y: 280, width: 360, height: 180 }
        },
        visibility: 'all'
    });
    agent.blackboard = blackboard.serializePrivileged();
    payload.roboTeamDemoCreated = true;
    return true;
}

export function projectRoboTeamParticipant(payload, meetingId = '') {
    const settings = ensureRoboTeamSettingsPayload(payload);
    const agent = ensureRoboTeamAgentPayload(payload);
    if (!isRoboTeamEnabled(settings) || agent.deletedAt || String(agent.status || '').trim() === 'detached') {
        return null;
    }
    return {
        id: ROBO_TEAM_PARTICIPANT_ID,
        identity: ROBO_TEAM_PARTICIPANT_ID,
        displayName: String(settings.assistant?.name || agent.agentName || 'Robo Team').trim() || 'Robo Team',
        kind: 'agent',
        joinedAt: agent.createdAt || nowIso(),
        lastSeenAt: nowIso(),
        pendingLiveKit: false,
        attributes: {
            webmeetAgent: 'true',
            webmeetMeetingId: String(meetingId || '').trim(),
            webmeetAgentType: ROBO_TEAM_AGENT_TYPE,
            webmeetAgentMode: ROBO_TEAM_MODE,
            webmeetAgentRuntime: 'ploinky'
        }
    };
}

export async function getRoboTeamSettings(context, { roomId, authInfo = null } = {}) {
    assertAdminAuthInfo(authInfo);
    const targetRoomId = String(roomId || '').trim();
    const record = await loadRoomRecord(context, targetRoomId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptRoomPayload(context, record);
    return {
        roomId: targetRoomId,
        settings: ensureRoboTeamSettingsPayload(payload)
    };
}

export async function updateRoboTeamSettings(context, { roomId, settings, authInfo = null } = {}) {
    assertAdminAuthInfo(authInfo);
    const targetRoomId = String(roomId || '').trim();
    let normalized = null;
    let agent = null;
    await mutateRoom(context, targetRoomId, (record, payload, stageEvent) => {
        if (!canViewMeetingRecord(record, authInfo)) {
            throw new Error('Meeting not found.');
        }
        normalized = normalizeRoboTeamSettings(settings);
        payload.roboTeamSettings = normalized;
        agent = ensureRoboTeamAgentPayload(payload, stageEvent, targetRoomId);
        if (normalized.blackboard.enabled) {
            const demoCreated = ensureRoboTeamDemoBlackboard(payload, targetRoomId);
            if (demoCreated) {
                const blackboard = Blackboard.from({
                    ...ensureRoboTeamBlackboardPayload(agent, targetRoomId),
                    roomId: targetRoomId
                });
                stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
                    meetingId: targetRoomId,
                    blackboardRevision: blackboard.revision,
                    changeType: 'create',
                    targetType: 'blackboard',
                    targetRef: '',
                    reason: 'robo_team_demo',
                    objectKind: 'blackboard'
                });
            }
        }
        stageEvent('meeting', WEBMEET_EVENT_TYPES.AGENT_DISPATCHED, {
            meetingId: targetRoomId,
            agentId: agent.id,
            agentType: ROBO_TEAM_AGENT_TYPE,
            mode: ROBO_TEAM_MODE,
            runtime: 'ploinky',
            status: agent.status
        });
    });
    return {
        roomId: targetRoomId,
        settings: normalized,
        agent
    };
}
