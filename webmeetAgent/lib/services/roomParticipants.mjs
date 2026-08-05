import { AsyncLocalStorage } from 'node:async_hooks';

import {
    sanitizeParticipantAvatarPayload
} from '../policies/avatarPolicy.mjs';
import { resolveEdgeJoinMaterial } from '../runtime/edgeRuntime.mjs';
import {
    BlackboardWorkspace
} from '../blackboard/workspace-model.mjs';
import {
    createLiveKitToken,
    getLiveKitParticipantIdentity,
    getParticipantAttributes,
    isLiveKitAgentParticipant,
    listLiveKitRoomParticipants,
    parseLiveKitProfileAvatar
} from '../runtime/livekitRuntime.mjs';
import {
    assertAdminAuthInfo,
    assertAuthenticatedAuthInfo,
    canViewMeetingRecord,
    getAuthDisplayName,
    hasWebmeetRoomScope,
    isAdminAuthInfo,
    isMeetingRecordOpen,
    normalizeAuthInfo
} from '../store/accessPolicy.mjs';
import {
    buildRoomView,
    decryptRoomPayload,
    getPresenceTtlMs,
    loadRoomRecord,
    mutateRoom
} from '../store/roomRecords.mjs';
import {
    WEBMEET_EVENT_TYPES
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';
import {
    ROBO_TEAM_AGENT_TYPE,
    ROBO_TEAM_MODE,
    ROBO_TEAM_PARTICIPANT_ID,
    ensureRoboTeamAgentPayload,
    ensureRoboTeamDemoBlackboard,
    ensureRoboTeamSettingsPayload,
    getRoboTeamAgentPayload,
    getRoboTeamBlackboardRevision,
    isRoboTeamEnabled,
    normalizeRoboTeamSettings,
    projectRoboTeamParticipant
} from '../roboTeam/service.mjs';

const PARTICIPANT_IDENTITY_OWNER_STATE_VERSION = 1;
const PARTICIPANT_OWNER_KINDS = new Set(['authenticated-user', 'guest-session']);
const verifiedGuestParticipantOwnerScope = new AsyncLocalStorage();

function nowIso() {
    return new Date().toISOString();
}

function normalizeParticipantOwner(owner = null) {
    const kind = String(owner?.kind || '').trim();
    const id = String(owner?.id || '').trim();
    if (!PARTICIPANT_OWNER_KINDS.has(kind) || !id) {
        throw new Error('Participant identity owner state is invalid.');
    }
    return { kind, id };
}

function resolveAuthenticatedParticipantOwner(authInfo = null) {
    assertAuthenticatedAuthInfo(authInfo);
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    const isGuestRole = auth.roles.some((role) => String(role || '').trim().toLowerCase() === 'guest');
    const invocationActorKind = String(authInfo?.invocation?.actor?.kind || '').trim().toLowerCase();
    if (!userId || isGuestRole || invocationActorKind === 'guest') {
        throw new Error('Access denied: an authenticated user is required to own a participant identity.');
    }
    return {
        kind: 'authenticated-user',
        id: userId
    };
}

function resolveVerifiedGuestParticipantOwner(authInfo = null, meetingId = '') {
    const targetMeetingId = String(meetingId || '').trim();
    if (!targetMeetingId || !hasWebmeetRoomScope(authInfo, targetMeetingId)) {
        throw new Error('Public room join scope does not match this room.');
    }
    const invocation = authInfo?.invocation && typeof authInfo.invocation === 'object'
        ? authInfo.invocation
        : null;
    const subject = String(invocation?.subject || '').trim();
    const actorKind = String(invocation?.actor?.kind || '').trim().toLowerCase();
    const actorId = String(invocation?.actor?.id || '').trim();
    const authenticatedUserId = String(normalizeAuthInfo(authInfo).id || '').trim();
    if (
        authenticatedUserId
        || actorKind !== 'guest'
        || actorId !== subject
        || !/^user:guest:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(subject)
    ) {
        throw new Error('Access denied: guest participant requires a verified guest session owner.');
    }
    return {
        kind: 'guest-session',
        id: subject
    };
}

/**
 * Carries the already-verified Router invocation owner across the guest facade
 * without accepting a caller-supplied owner field. AsyncLocalStorage keeps
 * concurrent guest joins on a shared service context isolated from one another.
 */
export async function withVerifiedGuestParticipantOwner(context, authInfo, meetingId, callback) {
    if (!context || typeof context !== 'object' || typeof callback !== 'function') {
        throw new Error('Access denied: guest participant requires a verified guest session owner.');
    }
    const targetMeetingId = String(meetingId || '').trim();
    const owner = resolveVerifiedGuestParticipantOwner(authInfo, targetMeetingId);
    return await verifiedGuestParticipantOwnerScope.run(Object.freeze({
        context,
        meetingId: targetMeetingId,
        owner: Object.freeze(owner)
    }), callback);
}

function getVerifiedGuestParticipantOwner(context, meetingId) {
    const binding = verifiedGuestParticipantOwnerScope.getStore();
    if (
        !binding
        || binding.context !== context
        || binding.meetingId !== String(meetingId || '').trim()
    ) {
        throw new Error('Access denied: guest participant requires a verified guest session owner.');
    }
    return normalizeParticipantOwner(binding.owner);
}

function getParticipantIdentityOwnerBindings(payload) {
    if (payload.participantIdentityOwners === undefined) {
        payload.participantIdentityOwners = {
            version: PARTICIPANT_IDENTITY_OWNER_STATE_VERSION,
            bindings: []
        };
    }
    const state = payload.participantIdentityOwners;
    if (
        !state
        || typeof state !== 'object'
        || Array.isArray(state)
        || state.version !== PARTICIPANT_IDENTITY_OWNER_STATE_VERSION
        || !Array.isArray(state.bindings)
    ) {
        throw new Error('Participant identity owner state is invalid.');
    }
    const seenParticipantIds = new Set();
    for (const binding of state.bindings) {
        const participantId = String(binding?.participantId || '').trim();
        normalizeParticipantOwner(binding?.owner);
        if (!participantId || seenParticipantIds.has(participantId)) {
            throw new Error('Participant identity owner state is invalid.');
        }
        seenParticipantIds.add(participantId);
    }
    return state.bindings;
}

function assertOrBindParticipantIdentity(payload, participantId, owner, existingParticipant = null) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    const normalizedOwner = normalizeParticipantOwner(owner);
    const bindings = getParticipantIdentityOwnerBindings(payload);
    const binding = bindings.find((entry) => String(entry?.participantId || '').trim() === targetParticipantId) || null;
    if (binding) {
        const boundOwner = normalizeParticipantOwner(binding.owner);
        if (boundOwner.kind !== normalizedOwner.kind || boundOwner.id !== normalizedOwner.id) {
            throw new Error('Access denied: participant identity is already bound to another caller.');
        }
        return;
    }
    if (existingParticipant) {
        throw new Error('Access denied: participant identity has no valid owner binding.');
    }
    bindings.push({
        participantId: targetParticipantId,
        owner: normalizedOwner,
        boundAt: nowIso()
    });
}

export function assertVerifiedGuestParticipantIdentity(context, meetingId, payload, participantId) {
    const participant = assertGuestParticipant(payload, participantId);
    const owner = getVerifiedGuestParticipantOwner(context, meetingId);
    assertOrBindParticipantIdentity(payload, participantId, owner, participant);
    return participant;
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

function needsRoboTeamPayloadNormalization(payload, meetingId = '') {
    const normalizedSettings = normalizeRoboTeamSettings(payload?.roboTeamSettings);
    if (stringifyStableJson(payload?.roboTeamSettings || null) !== stringifyStableJson(normalizedSettings)) {
        return true;
    }
    if (!Array.isArray(payload?.agents)) {
        return true;
    }
    const agent = getRoboTeamAgentPayload(payload);
    if (!agent) {
        return true;
    }
    const enabled = isRoboTeamEnabled(normalizedSettings);
    const expectedStatus = enabled ? 'active' : 'detached';
    if (String(agent.id || '').trim() !== ROBO_TEAM_PARTICIPANT_ID) return true;
    if (String(agent.participantIdentity || '').trim() !== ROBO_TEAM_PARTICIPANT_ID) return true;
    if (String(agent.agentType || '').trim() !== ROBO_TEAM_AGENT_TYPE) return true;
    if (String(agent.mode || '').trim() !== ROBO_TEAM_MODE) return true;
    if (String(agent.runtime || '').trim() !== 'ploinky') return true;
    if (String(agent.status || '').trim() !== expectedStatus) return true;
    if (enabled && agent.deletedAt) return true;
    if (!enabled && !agent.deletedAt) return true;
    const expectedName = String(normalizedSettings.assistant?.name || 'Robo Team').trim() || 'Robo Team';
    if (String(agent.agentName || '').trim() !== expectedName) return true;
    if (stringifyStableJson(agent.settings?.blackboard || null) !== stringifyStableJson(normalizedSettings.blackboard || null)) {
        return true;
    }
    if (!agent.blackboardWorkspace || typeof agent.blackboardWorkspace !== 'object') {
        return true;
    }
    if (needsBlackboardHistoryCompaction(agent.blackboardWorkspace)) {
        return true;
    }
    const widgets = Array.isArray(agent.blackboardWorkspace.boards)
        ? agent.blackboardWorkspace.boards.flatMap((board) => Array.isArray(board.widgets) ? board.widgets : [])
        : [];
    const shouldCreateDemo = enabled
        && normalizedSettings.blackboard?.enabled
        && payload?.roboTeamDemoCreated !== true
        && widgets.length === 0;
    if (shouldCreateDemo) {
        return true;
    }
    return false;
}

function historyEntryContainsNestedHistory(entry = {}) {
    return Boolean(
        entry?.beforeObject?.history
        || entry?.afterObject?.history
    );
}

function needsBlackboardHistoryCompaction(blackboard = {}) {
    const history = blackboard?.history;
    if (!history || typeof history !== 'object') {
        return false;
    }
    const maxDepth = Number.parseInt(String(history.maxDepth || 5), 10) || 5;
    const undoStack = Array.isArray(history.undoStack) ? history.undoStack : [];
    const redoStack = Array.isArray(history.redoStack) ? history.redoStack : [];
    return undoStack.length > maxDepth
        || redoStack.length > maxDepth
        || undoStack.some(historyEntryContainsNestedHistory)
        || redoStack.some(historyEntryContainsNestedHistory);
}

function compactRoboTeamBlackboardHistory(payload, meetingId = '') {
    const agent = getRoboTeamAgentPayload(payload);
    if (!agent?.blackboardWorkspace || typeof agent.blackboardWorkspace !== 'object') {
        return false;
    }
    if (!needsBlackboardHistoryCompaction(agent.blackboardWorkspace)) {
        return false;
    }
    agent.blackboardWorkspace = BlackboardWorkspace.from({
        ...agent.blackboardWorkspace,
        roomId: String(agent.blackboardWorkspace.roomId || meetingId || '').trim()
    }).serializePrivileged();
    return true;
}

function normalizeRoboTeamPayload(payload, meetingId, stageEvent = null) {
    ensureRoboTeamSettingsPayload(payload);
    ensureRoboTeamAgentPayload(payload, stageEvent, meetingId);
    compactRoboTeamBlackboardHistory(payload, meetingId);
    const demoCreated = ensureRoboTeamDemoBlackboard(payload, meetingId);
    if (demoCreated && stageEvent) {
        stageEvent('meeting', WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED, {
            meetingId,
            blackboardRevision: getRoboTeamBlackboardRevision(payload),
            changeType: 'create',
            targetType: 'blackboard',
            targetRef: '',
            reason: 'robo_team_demo',
            objectKind: 'blackboard'
        });
    }
    return payload;
}

function toTimestamp(value) {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function getParticipantDeps(deps = {}) {
    return {
        randomId: typeof deps.randomId === 'function'
            ? deps.randomId
            : ((prefix) => `${prefix}_${crypto.randomUUID()}`),
        detachActiveAgentsWhenRoomHasNoHumans: typeof deps.detachActiveAgentsWhenRoomHasNoHumans === 'function'
            ? deps.detachActiveAgentsWhenRoomHasNoHumans
            : (async () => []),
        ensureMeetingSecretaryDispatch: typeof deps.ensureMeetingSecretaryDispatch === 'function'
            ? deps.ensureMeetingSecretaryDispatch
            : (async () => ({ ok: true, disabled: true }))
    };
}

function hasHumanRoomMembers(payload) {
    return Array.isArray(payload?.members) && payload.members.length > 0;
}

function scheduleEmptyRoomAgentDetach(context, meetingId, deps, reason = 'no_human_participants') {
    const targetMeetingId = String(meetingId || '').trim();
    const detachActiveAgents = getParticipantDeps(deps).detachActiveAgentsWhenRoomHasNoHumans;
    if (!targetMeetingId) return;
    setTimeout(() => {
        detachActiveAgents(context, targetMeetingId, reason).catch(() => {});
    }, 0);
}

function cleanupStaleMembers(context, meetingId, payload, stageEvent = null, deps = {}) {
    const now = Date.now();
    const ttlMs = getPresenceTtlMs(context.workspaceRoot);
    const members = Array.isArray(payload.members) ? payload.members : [];
    const kept = [];
    const removed = [];
    for (const member of members) {
        const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
        if (!lastSeenAt || (now - lastSeenAt) > ttlMs) {
            removed.push(member);
            continue;
        }
        kept.push(member);
    }
    if (removed.length > 0) {
        payload.members = kept;
        for (const member of removed) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || !stageEvent) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_TIMED_OUT, { meetingId, participantId });
        }
        if (kept.length === 0) {
            scheduleEmptyRoomAgentDetach(context, meetingId, deps, 'no_human_participants');
        }
    }
    return removed;
}

export async function cleanupRoomPresence(context, meetingId, deps = {}) {
    let removedCount = 0;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        removedCount = cleanupStaleMembers(context, meetingId, payload, stageEvent, deps).length;
        if (!hasHumanRoomMembers(payload)) {
            scheduleEmptyRoomAgentDetach(context, meetingId, deps, 'no_human_participants');
        }
    });
    return removedCount;
}

function projectLiveKitRoomParticipants(payload, liveParticipants) {
    const now = nowIso();
    const cachedMembers = Array.isArray(payload?.members) ? payload.members : [];
    const cachedById = new Map(cachedMembers.map((member) => [String(member?.id || '').trim(), member]).filter(([id]) => id));
    const projected = [];
    for (const liveParticipant of Array.isArray(liveParticipants) ? liveParticipants : []) {
        if (isLiveKitAgentParticipant(liveParticipant)) continue;
        const participantId = getLiveKitParticipantIdentity(liveParticipant);
        if (!participantId) continue;
        const cached = cachedById.get(participantId) || {};
        const liveAttributes = getParticipantAttributes(liveParticipant);
        projected.push({
            ...cached,
            id: participantId,
            displayName: String(liveParticipant?.name || cached.displayName || participantId).trim() || participantId,
            joinedAt: cached.joinedAt || now,
            lastSeenAt: now,
            pendingLiveKit: false,
            profileAvatar: parseLiveKitProfileAvatar(liveAttributes),
            attributes: {
                ...(cached.attributes && typeof cached.attributes === 'object' ? cached.attributes : {}),
                ...liveAttributes
            }
        });
    }
    return projected;
}

function shouldPreserveStoredMemberDuringReconcile(context, member) {
    if (member?.pendingLiveKit !== true) {
        return false;
    }
    const lastSeenAt = toTimestamp(member?.lastSeenAt) ?? toTimestamp(member?.joinedAt);
    if (!lastSeenAt) {
        return false;
    }
    return (Date.now() - lastSeenAt) <= getPresenceTtlMs(context.workspaceRoot);
}

function syncPayloadMembersToLiveKitParticipants(context, record, payload, participants, stageEvent) {
    const currentMembers = Array.isArray(payload.members) ? payload.members : [];
    const preservedMembers = currentMembers.filter((member) => {
        const participantId = String(member?.id || '').trim();
        if (!participantId) return false;
        if (participants.some((entry) => String(entry?.id || '').trim() === participantId)) return false;
        return shouldPreserveStoredMemberDuringReconcile(context, member);
    });
    const nextParticipants = [...participants, ...preservedMembers];
    const currentIds = new Set(currentMembers.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const nextIds = new Set(nextParticipants.map((member) => String(member?.id || '').trim()).filter(Boolean));
    const membershipChanged = currentIds.size !== nextIds.size
        || [...currentIds].some((participantId) => !nextIds.has(participantId));

    payload.members = nextParticipants.map((member) => {
        const attributes = member?.attributes && typeof member.attributes === 'object'
            ? member.attributes
            : {};
        const {
            webmeetProfileAvatar: _webmeetProfileAvatar,
            ...durableAttributes
        } = attributes;
        const { profileAvatar: _profileAvatar, ...durableMember } = member || {};
        return {
            ...durableMember,
            ...(Object.keys(durableAttributes).length ? { attributes: durableAttributes } : {})
        };
    });
    if (membershipChanged) {
        for (const member of currentMembers) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || nextIds.has(participantId)) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId: record.meetingId,
                participantId,
                reason: 'livekit_reconcile'
            });
        }
        for (const member of participants) {
            const participantId = String(member?.id || '').trim();
            if (!participantId || currentIds.has(participantId)) continue;
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
                meetingId: record.meetingId,
                participantId,
                source: 'livekit_reconcile'
            });
        }
    }
    return nextParticipants;
}

export function projectStoredRoomParticipants(payload, meetingId = '') {
    const members = Array.isArray(payload?.members) ? payload.members : [];
    const participants = members
        .map((member) => ({
            ...member,
            id: String(member?.id || '').trim(),
            identity: String(member?.identity || member?.id || '').trim(),
            displayName: String(member?.displayName || member?.id || 'Participant').trim() || 'Participant'
        }))
        .filter((member) => member.id);
    const roboTeam = projectRoboTeamParticipant(payload, meetingId);
    if (roboTeam && !participants.some((entry) => String(entry?.id || '').trim() === roboTeam.id)) {
        participants.push(roboTeam);
    }
    return participants;
}

function appendRoboTeamParticipant(payload, participants, meetingId = '') {
    const nextParticipants = Array.isArray(participants) ? [...participants] : [];
    const roboTeam = projectRoboTeamParticipant(payload, meetingId);
    if (roboTeam && !nextParticipants.some((entry) => String(entry?.id || entry?.identity || '').trim() === roboTeam.id)) {
        nextParticipants.push(roboTeam);
    }
    return nextParticipants;
}

function projectRoomAgentForDetails(agent = {}) {
    const blackboard = agent?.blackboardWorkspace && typeof agent.blackboardWorkspace === 'object'
        ? {
            id: String(agent.blackboardWorkspace.id || '').trim(),
            roomId: String(agent.blackboardWorkspace.roomId || '').trim(),
            revision: Number(agent.blackboardWorkspace.revision || 0),
            boardCount: Array.isArray(agent.blackboardWorkspace.boards) ? agent.blackboardWorkspace.boards.length : 0,
            activeBoardId: String(agent.blackboardWorkspace.activeBoardId || '').trim(),
        }
        : null;
    return {
        id: String(agent.id || '').trim(),
        participantIdentity: String(agent.participantIdentity || agent.participant?.identity || '').trim(),
        agentType: String(agent.agentType || '').trim(),
        mode: String(agent.mode || '').trim(),
        agentName: String(agent.agentName || agent.participant?.name || '').trim(),
        runtime: String(agent.runtime || 'ploinky').trim(),
        status: String(agent.status || '').trim(),
        createdAt: String(agent.createdAt || '').trim(),
        updatedAt: String(agent.updatedAt || '').trim(),
        deletedAt: agent.deletedAt || null,
        settings: agent.settings && typeof agent.settings === 'object'
            ? { blackboard: agent.settings.blackboard || null }
            : undefined,
        ...(blackboard ? { blackboard } : {})
    };
}

export async function getRealtimeRoomParticipants(context, record, payload, options = {}, deps = {}) {
    const liveParticipants = await listLiveKitRoomParticipants(context, record.roomName);
    if (options.preserveStoredMembersOnEmpty === true && liveParticipants.length === 0) {
        return projectStoredRoomParticipants(payload, record.meetingId);
    }
    let reconciledParticipants = [];
    await mutateRoom(context, record.meetingId, (lockedRecord, lockedPayload, stageEvent) => {
        const participants = projectLiveKitRoomParticipants(lockedPayload, liveParticipants);
        reconciledParticipants = syncPayloadMembersToLiveKitParticipants(
            context,
            lockedRecord,
            lockedPayload,
            participants,
            stageEvent
        );
    });
    if (reconciledParticipants.length === 0) {
        scheduleEmptyRoomAgentDetach(context, record.meetingId, deps, 'no_human_participants');
    }
    return reconciledParticipants;
}

export async function getRoomDetails(context, meetingId, authInfo = null, options = {}, deps = {}) {
    let record = await loadRoomRecord(context, meetingId);
    if (!canViewMeetingRecord(record, authInfo)) {
        throw new Error('Meeting not found.');
    }
    const payload = decryptRoomPayload(context, record);
    let normalizedPayload = payload;
    if (needsRoboTeamPayloadNormalization(payload, meetingId)) {
        const mutation = await mutateRoom(context, meetingId, (_record, lockedPayload, stageEvent) => {
            normalizeRoboTeamPayload(lockedPayload, meetingId, stageEvent);
        });
        record = mutation.record;
        normalizedPayload = mutation.payload;
    }
    const participants = options.includeParticipants === false
        ? projectStoredRoomParticipants(normalizedPayload, meetingId)
        : appendRoboTeamParticipant(normalizedPayload, await getRealtimeRoomParticipants(context, record, normalizedPayload, {}, deps), meetingId);
    return {
        meeting: buildRoomView(record),
        participants,
        meetingNotes: {
            enabled: Boolean(normalizeRoboTeamSettings(normalizedPayload.roboTeamSettings).meetingNotes.enabled),
        },
        agents: Array.isArray(normalizedPayload.agents)
            ? normalizedPayload.agents.map(projectRoomAgentForDetails)
            : []
    };
}

export function assertGuestRoomAccess(record) {
    if (record.roomType !== 'guest') {
        throw new Error('Meeting does not support guest access.');
    }
    if (!isMeetingRecordOpen(record)) {
        throw new Error('Meeting not found.');
    }
}

export function assertGuestParticipant(payload, participantId) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    const participant = (Array.isArray(payload.members) ? payload.members : []).find((entry) => (
        String(entry?.id || '').trim() === targetParticipantId
        && (
            entry?.guest === true
            || !String(entry?.userId || '').trim()
        )
    )) || null;
    if (!participant) {
        throw new Error('Guest participant is not joined.');
    }
    return participant;
}

export async function joinGuestRoom(context, { meetingId, displayName, participantId }, deps = {}) {
    const { randomId } = getParticipantDeps(deps);
    const participantOwner = getVerifiedGuestParticipantOwner(context, meetingId);
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || 'Guest').trim() || 'Guest';
    const joinedAt = nowIso();

    let participant = null;
    let meetingNotes = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const members = Array.isArray(payload.members) ? payload.members : [];
        payload.members = members;
        participant = members.find((p) => p.id === participantIdentity);
        assertOrBindParticipantIdentity(payload, participantIdentity, participantOwner, participant);
        if (!participant) {
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                guest: true,
                pendingLiveKit: true
            };
            members.push(participant);
        } else {
            participant.displayName = effectiveDisplayName;
            participant.lastSeenAt = joinedAt;
            participant.guest = true;
            participant.pendingLiveKit = true;
        }
        stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participantIdentity, guest: true });
        meetingNotes = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
    });
    await getParticipantDeps(deps).ensureMeetingSecretaryDispatch(context, meetingId).catch(() => {});
    const joinMaterial = await resolveEdgeJoinMaterial(context, {
        roomName: record.roomName,
        participantIdentity: participant.id
    });
    const participantToken = createLiveKitToken(context, {
        roomName: record.roomName,
        identity: participant.id,
        name: effectiveDisplayName
    });
    if (!participantToken) throw new Error('LiveKit participant token could not be created.');

    return {
        meeting: buildRoomView(record),
        participant,
        ...joinMaterial,
        roomName: record.roomName,
        participantToken,
        participantIdentity: participant.id,
        meetingNotes
    };
}

export async function getGuestRoomDetails(context, { meetingId, participantId }, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    const payload = decryptRoomPayload(context, record);
    assertVerifiedGuestParticipantIdentity(context, meetingId, payload, participantId);
    let participants;
    try {
        participants = await getRealtimeRoomParticipants(context, record, payload, {
            preserveStoredMembersOnEmpty: true
        }, deps);
    } catch {
        participants = projectStoredRoomParticipants(payload);
    }
    return {
        meeting: buildRoomView(record),
        participants,
        chat: payload.chatMessages,
    };
}

export async function leaveGuestRoom(context, { meetingId, participantId }, deps = {}) {
    const record = await loadRoomRecord(context, meetingId);
    assertGuestRoomAccess(record);
    return leaveRoom(context, { meetingId, participantId }, deps);
}

export async function updateGuestRoomParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const record = await loadRoomRecord(context, targetMeetingId);
    assertGuestRoomAccess(record);
    let profileAvatar = null;
    await mutateRoom(context, targetMeetingId, async (_record, payload) => {
        assertVerifiedGuestParticipantIdentity(context, targetMeetingId, payload, targetParticipantId);
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${targetParticipantId}`);
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

export async function joinRoom(context, { meetingId, displayName, participantId, authInfo = null }, deps = {}) {
    const { randomId } = getParticipantDeps(deps);
    const participantOwner = resolveAuthenticatedParticipantOwner(authInfo);
    const existingRecord = await loadRoomRecord(context, meetingId);
    if (!canViewMeetingRecord(existingRecord, authInfo)) {
        throw new Error('Room not found.');
    }
    const participantIdentity = String(participantId || randomId('participant')).trim();
    const effectiveDisplayName = String(displayName || getAuthDisplayName(authInfo) || 'Participant').trim() || 'Participant';
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    const participantAttributes = userId
        ? {
            webmeetUserId: userId,
            userId,
            workspaceUserId: userId,
            ploinkyUserId: userId
        }
        : {};
    const joinedAt = nowIso();
    let participant = null;
    let meetingNotes = null;
    const { record } = await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        cleanupStaleMembers(context, meetingId, payload, stageEvent, deps);
        const members = Array.isArray(payload.members) ? payload.members : [];
        payload.members = members;
        participant = members.find((entry) => entry.id === participantIdentity) || null;
        assertOrBindParticipantIdentity(payload, participantIdentity, participantOwner, participant);
        if (!participant) {
            participant = {
                id: participantIdentity,
                displayName: effectiveDisplayName,
                joinedAt,
                lastSeenAt: joinedAt,
                pendingLiveKit: true
            };
            members.push(participant);
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, { meetingId, participantId: participant.id });
        } else {
            participant.displayName = effectiveDisplayName;
            if (!participant.joinedAt) {
                participant.joinedAt = joinedAt;
            }
            participant.lastSeenAt = joinedAt;
            participant.pendingLiveKit = true;
        }
        if (userId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                ...participantAttributes
            };
        }
        meetingNotes = normalizeRoboTeamSettings(payload.roboTeamSettings).meetingNotes;
    });
    await getParticipantDeps(deps).ensureMeetingSecretaryDispatch(context, meetingId).catch(() => {});
    const joinMaterial = await resolveEdgeJoinMaterial(context, {
        roomName: record.roomName,
        participantIdentity: participant.id
    });
    const participantToken = createLiveKitToken(context, {
        roomName: record.roomName,
        identity: participant.id,
        name: effectiveDisplayName,
        attributes: participantAttributes,
        metadata: userId ? JSON.stringify({ webmeetUserId: userId }) : ''
    });
    if (!participantToken) throw new Error('LiveKit participant token could not be created.');
    return {
        meeting: buildRoomView(record),
        participant,
        ...joinMaterial,
        roomName: record.roomName,
        participantToken,
        meetingNotes,
        participantIdentity: participant.id
    };
}

export async function updateRoomParticipantAvatar(context, {
    meetingId,
    participantId,
    avatar = null,
    authInfo = null
} = {}) {
    const targetMeetingId = String(meetingId || '').trim();
    const targetParticipantId = String(participantId || '').trim();
    if (!targetMeetingId) {
        throw new Error('Missing meeting id.');
    }
    if (!targetParticipantId) {
        throw new Error('Missing participant id.');
    }
    const auth = normalizeAuthInfo(authInfo);
    const userId = String(auth.id || '').trim();
    if (!userId) {
        throw new Error('Authentication is required to publish a participant avatar.');
    }
    let participant = null;
    let profileAvatar = null;
    await mutateRoom(context, targetMeetingId, async (_record, payload) => {
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        const participantUserId = String(participant.userId || participant.attributes?.webmeetUserId || '').trim();
        if (participantUserId && participantUserId !== userId && !isAdminAuthInfo(authInfo)) {
            throw new Error('Access denied: cannot publish another participant avatar.');
        }
        if (!participantUserId) {
            participant.userId = userId;
            participant.attributes = {
                ...(participant.attributes && typeof participant.attributes === 'object' ? participant.attributes : {}),
                webmeetUserId: userId,
                userId,
                workspaceUserId: userId,
                ploinkyUserId: userId
            };
        }
        profileAvatar = sanitizeParticipantAvatarPayload(avatar, `profile:${userId}`);
    });
    return {
        ok: true,
        meetingId: targetMeetingId,
        participantId: targetParticipantId,
        profileAvatar
    };
}

function assertParticipantAccess(context, payload, participantId, authInfo = null, roomId = '') {
    if (isAdminAuthInfo(authInfo)) {
        return;
    }
    const auth = normalizeAuthInfo(authInfo);
    if (!auth.id) {
        if (hasWebmeetRoomScope(authInfo, roomId)) {
            const guestParticipant = (Array.isArray(payload?.members) ? payload.members : []).find((entry) => (
                String(entry?.id || '').trim() === String(participantId || '').trim()
                    && entry?.guest === true
            )) || null;
            if (guestParticipant) {
                const owner = getVerifiedGuestParticipantOwner(context, roomId);
                assertOrBindParticipantIdentity(payload, participantId, owner, guestParticipant);
                return;
            }
        }
        throw new Error('Access denied: participant authentication is required.');
    }
    const participant = (Array.isArray(payload?.members) ? payload.members : []).find((entry) => (
        String(entry?.id || '').trim() === String(participantId || '').trim()
    )) || null;
    const participantUserId = String(participant?.userId || participant?.attributes?.webmeetUserId || '').trim();
    if (!participant || participantUserId !== auth.id) {
        throw new Error('Access denied: cannot act as another participant.');
    }
    assertOrBindParticipantIdentity(
        payload,
        participantId,
        resolveAuthenticatedParticipantOwner(authInfo),
        participant,
    );
}

export async function leaveRoom(context, { meetingId, participantId, authInfo = null, skipAccessCheck = false }, deps = {}) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    let noHumanParticipantsRemain = false;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        if (!skipAccessCheck) {
            assertParticipantAccess(context, payload, targetParticipantId, authInfo, meetingId);
        }
        const existingMembers = Array.isArray(payload.members) ? payload.members : [];
        const nextMembers = existingMembers.filter((entry) => {
            const sameParticipant = String(entry?.id || '').trim() === targetParticipantId;
            if (sameParticipant && !removedParticipant) {
                removedParticipant = entry;
            }
            return !sameParticipant;
        });
        payload.members = nextMembers;
        if (removedParticipant) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId,
                participantId: targetParticipantId
            });
        }
        noHumanParticipantsRemain = nextMembers.length === 0;
    });
    const detachedAgents = noHumanParticipantsRemain
        ? await getParticipantDeps(deps).detachActiveAgentsWhenRoomHasNoHumans(context, meetingId, 'no_human_participants')
        : [];
    return {
        ok: true,
        removed: Boolean(removedParticipant),
        participantId: targetParticipantId,
        detachedAgents
    };
}

export async function heartbeatRoomPresence(context, { meetingId, participantId, authInfo = null }, deps = {}) {
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let participant = null;
    await mutateRoom(context, meetingId, (record, payload, stageEvent) => {
        if (!isMeetingRecordOpen(record)) {
            throw new Error('Room not found.');
        }
        assertParticipantAccess(context, payload, targetParticipantId, authInfo, meetingId);
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        participant.lastSeenAt = nowIso();
        cleanupStaleMembers(context, meetingId, payload, stageEvent, deps);
    });
    let meetingSecretaryRecovery = null;
    try {
        meetingSecretaryRecovery = await getParticipantDeps(deps)
            .ensureMeetingSecretaryDispatch(context, meetingId);
    } catch (error) {
        meetingSecretaryRecovery = {
            ok: false,
            retryable: true,
            message: String(error?.message || 'Meeting Secretary recovery failed.'),
        };
    }
    return { ok: true, participant, meetingSecretaryRecovery };
}

export async function listRoomParticipants(context, meetingId, authInfo = null, deps = {}) {
    const details = await getRoomDetails(context, meetingId, authInfo, { includeParticipants: true }, deps);
    return { participants: Array.isArray(details?.participants) ? details.participants : [] };
}

export async function updateRoomParticipantRole(context, { meetingId, participantId, role, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const targetParticipantId = String(participantId || '').trim();
    const nextRole = String(role || '').trim();
    if (!targetParticipantId || !nextRole) {
        throw new Error('Missing participant role update fields.');
    }
    let participant = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        participant = (Array.isArray(payload.members) ? payload.members : [])
            .find((entry) => String(entry?.id || '').trim() === targetParticipantId) || null;
        if (!participant) {
            throw new Error('Participant is not joined.');
        }
        participant.role = nextRole;
        participant.updatedAt = nowIso();
        stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_JOINED, {
            meetingId,
            participantId: targetParticipantId,
            role: nextRole,
            reason: 'role_updated'
        });
    });
    return { ok: true, participant };
}

export async function removeRoomParticipant(context, { meetingId, participantId, authInfo = null }) {
    assertAdminAuthInfo(authInfo);
    const targetParticipantId = String(participantId || '').trim();
    if (!targetParticipantId) {
        throw new Error('Missing participantId.');
    }
    let removedParticipant = null;
    await mutateRoom(context, meetingId, (_record, payload, stageEvent) => {
        const existingMembers = Array.isArray(payload.members) ? payload.members : [];
        payload.members = existingMembers.filter((entry) => {
            const sameParticipant = String(entry?.id || '').trim() === targetParticipantId;
            if (sameParticipant && !removedParticipant) {
                removedParticipant = entry;
            }
            return !sameParticipant;
        });
        if (removedParticipant) {
            stageEvent('meeting', WEBMEET_EVENT_TYPES.PARTICIPANT_LEFT, {
                meetingId,
                participantId: targetParticipantId,
                reason: 'admin_removed'
            });
        }
    });
    return { ok: Boolean(removedParticipant), participantId: targetParticipantId };
}
import crypto from 'node:crypto';
