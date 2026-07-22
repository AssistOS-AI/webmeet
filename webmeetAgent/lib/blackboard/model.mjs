export const BLACKBOARD_WIDGET_TYPES = Object.freeze([
    'shape',
    'line',
    'text',
    'image',
    'card',
    'poll',
    'bullets',
    'scripta-document',
    'embed'
]);

export const BLACKBOARD_CHANGE_TYPES = Object.freeze([
    'create',
    'update',
    'delete',
    'group',
    'ungroup',
    'focus',
    'submit',
    'start',
    'close',
    'reorder',
    'clear'
]);

export const DEFAULT_BLACKBOARD_HISTORY_DEPTH = 5;
export const MIN_BLACKBOARD_HISTORY_DEPTH = 3;

const PRIVILEGED_ROLES = new Set(['admin', 'moderator', 'agent', 'evaluator']);

function nowIso() {
    return new Date().toISOString();
}

function randomId(prefix) {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}_${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function cloneJson(value) {
    if (value === undefined || value === null) {
        return value;
    }
    return JSON.parse(JSON.stringify(value));
}

function cloneHistorySnapshot(value) {
    if (Array.isArray(value)) {
        return value.map((entry) => cloneHistorySnapshot(entry));
    }
    if (!isPlainObject(value)) {
        return cloneJson(value);
    }
    const output = {};
    for (const [key, entryValue] of Object.entries(value)) {
        if (key === 'history' || key === 'privateRoboContext') {
            continue;
        }
        output[key] = cloneHistorySnapshot(entryValue);
    }
    return output;
}

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteLineCoordinates(value = {}) {
    const coordinates = [value.x1, value.y1, value.x2, value.y2].map(Number);
    return coordinates.every(Number.isFinite) ? coordinates : null;
}

export function normalizeFreeLineProperties(properties = {}) {
    const normalized = cloneJson(properties || {});
    if (normalized.connection) return normalized;
    const geometry = isPlainObject(normalized.geometry) ? normalized.geometry : null;
    const canonicalLine = isPlainObject(normalized.line) ? normalized.line : null;
    const embeddedCoordinates = !canonicalLine && geometry ? finiteLineCoordinates(geometry) : null;
    const absoluteCoordinates = !geometry && canonicalLine ? finiteLineCoordinates(canonicalLine) : embeddedCoordinates;
    if (!absoluteCoordinates) return normalized;

    const [x1, y1, x2, y2] = absoluteCoordinates;
    const padding = 0.5;
    const x = Math.min(x1, x2) - padding;
    const y = Math.min(y1, y2) - padding;
    const lineSource = canonicalLine || geometry || {};
    const { x1: _x1, y1: _y1, x2: _x2, y2: _y2, x: _x, y: _y, width: _width, height: _height, rotation: _rotation, ...lineOptions } = lineSource;
    normalized.geometry = {
        x,
        y,
        width: Math.max(1, Math.abs(x2 - x1) + padding * 2),
        height: Math.max(1, Math.abs(y2 - y1) + padding * 2),
        rotation: 0,
    };
    normalized.line = {
        ...lineOptions,
        x1: x1 - x,
        y1: y1 - y,
        x2: x2 - x,
        y2: y2 - y,
    };
    return normalized;
}

export function mergePlainObject(target, patch) {
    if (!isPlainObject(patch)) {
        return cloneJson(patch);
    }
    const output = isPlainObject(target) ? cloneJson(target) : {};
    for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) {
            continue;
        }
        output[key] = isPlainObject(value) && isPlainObject(output[key])
            ? mergePlainObject(output[key], value)
            : cloneJson(value);
    }
    return output;
}

function resetThemeStyleProperties(properties = {}, widgetType = '') {
    if (!isPlainObject(properties?.style)) {
        return false;
    }
    const nextStyle = cloneJson(properties.style);
    const keysByType = {
        shape: ['fill', 'stroke'],
        line: ['stroke'],
        text: ['fill', 'stroke', 'textColor'],
        card: ['fill', 'stroke', 'textColor'],
        poll: ['fill', 'stroke', 'textColor'],
        bullets: ['fill', 'stroke', 'textColor'],
        'scripta-document': ['fill', 'stroke', 'textColor'],
        embed: ['fill', 'stroke', 'textColor'],
        image: ['stroke']
    };
    const keys = keysByType[String(widgetType || '').trim()] || ['fill', 'stroke', 'textColor'];
    let changed = false;
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(nextStyle, key)) {
            delete nextStyle[key];
            changed = true;
        }
    }
    if (!changed) {
        return false;
    }
    properties.style = nextStyle;
    return true;
}

function normalizeWidgetType(type) {
    const rawType = String(type || '').trim();
    const normalized = rawType === 'vote' ? 'poll' : rawType;
    if (!BLACKBOARD_WIDGET_TYPES.includes(normalized)) {
        throw new Error(`Unsupported blackboard widget type "${normalized}".`);
    }
    return normalized;
}

function normalizeVisibility(visibility = 'all') {
    if (typeof visibility === 'string') {
        return { mode: visibility };
    }
    if (isPlainObject(visibility)) {
        return { mode: String(visibility.mode || 'all').trim() || 'all', ...cloneJson(visibility) };
    }
    return { mode: 'all' };
}

function normalizeHistoryDepth(maxDepth = DEFAULT_BLACKBOARD_HISTORY_DEPTH) {
    const parsed = Number.parseInt(String(maxDepth || ''), 10);
    return Math.max(MIN_BLACKBOARD_HISTORY_DEPTH, Number.isFinite(parsed) ? parsed : DEFAULT_BLACKBOARD_HISTORY_DEPTH);
}

function getViewerParticipantId(viewerContext = {}) {
    return String(
        viewerContext.participantId
        || viewerContext.userId
        || viewerContext.agentId
        || viewerContext.id
        || ''
    ).trim();
}

function isPrivilegedViewer(viewerContext = {}) {
    if (viewerContext.canViewAllParticipantData === true || viewerContext.canModerateBlackboard === true) {
        return true;
    }
    if (viewerContext.kind === 'agent' && viewerContext.authorized !== false) {
        return true;
    }
    const roles = Array.isArray(viewerContext.roles) ? viewerContext.roles : [];
    return roles.some((role) => PRIVILEGED_ROLES.has(String(role || '').trim().toLowerCase()));
}

function isVisibleForContext(visibility, viewerContext = {}) {
    const normalized = normalizeVisibility(visibility);
    const participantId = getViewerParticipantId(viewerContext);
    const [modeKind, modeId] = String(normalized.mode || '').split(':');
    switch (normalized.mode) {
    case 'all':
        return true;
    case 'participants':
        return viewerContext.kind !== 'agent' || isPrivilegedViewer(viewerContext);
    case 'moderators':
    case 'privileged':
        return isPrivilegedViewer(viewerContext);
    case 'owner':
        return String(normalized.ownerId || '').trim() === participantId || isPrivilegedViewer(viewerContext);
    case 'participantsList':
        return (Array.isArray(normalized.participantIds) ? normalized.participantIds : [])
            .map((id) => String(id || '').trim())
            .includes(participantId) || isPrivilegedViewer(viewerContext);
    default:
        if (modeKind === 'user') {
            return String(modeId || '').trim() === participantId || isPrivilegedViewer(viewerContext);
        }
        if (modeKind === 'agent') {
            return viewerContext.kind === 'agent'
                && String(modeId || '').trim() === participantId
                || isPrivilegedViewer(viewerContext);
        }
        if (modeKind === 'policy') {
            return isPrivilegedViewer(viewerContext);
        }
        return isPrivilegedViewer(viewerContext);
    }
}

function canSeeAggregation(properties = {}, viewerContext = {}) {
    const participantId = getViewerParticipantId(viewerContext);
    const ownerParticipantId = String(properties.ownerParticipantId || '').trim();
    if (ownerParticipantId && ownerParticipantId === participantId) {
        return true;
    }
    const resultsVisibility = String(
        properties.resultsVisibility
        || properties.aggregation?.resultsVisibility
        || 'moderators'
    ).trim();
    if (resultsVisibility === 'public' || resultsVisibility === 'live') {
        return true;
    }
    if (resultsVisibility === 'hidden') {
        return false;
    }
    if (resultsVisibility === 'afterSubmit' || resultsVisibility === 'afterPoll') {
        return isPrivilegedViewer(viewerContext) || Boolean(participantId && properties.participantData?.[participantId]);
    }
    if (resultsVisibility === 'afterClose') {
        return Boolean(properties.closed) || isPrivilegedViewer(viewerContext);
    }
    if (resultsVisibility === 'moderatorsOnly') {
        return isPrivilegedViewer(viewerContext);
    }
    return isPrivilegedViewer(viewerContext);
}

function filterPropertiesForViewer(properties = {}, viewerContext = {}) {
    const filtered = cloneJson(properties) || {};
    const participantId = getViewerParticipantId(viewerContext);
    const ownerParticipantId = String(filtered.ownerParticipantId || '').trim();
    const privileged = isPrivilegedViewer(viewerContext) || Boolean(ownerParticipantId && ownerParticipantId === participantId);
    const aggregationVisible = canSeeAggregation(filtered, viewerContext);
    if (ownerParticipantId) {
        filtered.canManagePoll = Boolean(ownerParticipantId === participantId) || isPrivilegedViewer(viewerContext);
    }

    if (filtered.participantData && !privileged && (filtered.anonymous || !aggregationVisible)) {
        filtered.participantData = participantId && filtered.participantData[participantId] !== undefined
            ? { [participantId]: cloneJson(filtered.participantData[participantId]) }
            : {};
    }
    if (filtered.participantData && filtered.anonymous && !privileged) {
        filtered.participantData = {};
    }

    if (!aggregationVisible) {
        delete filtered.aggregation;
    }

    if (!privileged) {
        delete filtered.correctAnswer;
        delete filtered.scoring;
    }

    const guestViewer = (viewerContext?.roles || []).some((role) => String(role || '').toLowerCase() === 'guest');
    if (Array.isArray(filtered.documents) && Object.prototype.hasOwnProperty.call(filtered, 'viewMode')) {
        filtered.canBrowseWorkspace = Boolean(String(viewerContext?.userId || '').trim() && !guestViewer);
    }
    if (!String(viewerContext?.userId || '').trim() || guestViewer) {
        delete filtered.editorUrl;
        delete filtered.documentId;
    }
    if (filtered._viewerVotes && typeof filtered._viewerVotes === 'object') {
        filtered.viewerVote = participantId ? cloneJson(filtered._viewerVotes[participantId] || null) : null;
    }
    delete filtered._viewerVotes;
    if (filtered.paragraph?._viewerVotes && typeof filtered.paragraph._viewerVotes === 'object') {
        filtered.paragraph.viewerVote = participantId
            ? cloneJson(filtered.paragraph._viewerVotes[participantId] || null)
            : null;
    }
    if (filtered.paragraph) delete filtered.paragraph._viewerVotes;
    if (Array.isArray(filtered.paragraph?.variants)) {
        const viewerHash = String(viewerContext?.scriptaOwnerHash || '').trim();
        filtered.paragraph.variants = filtered.paragraph.variants.map((variant) => {
            const projected = cloneJson(variant) || {};
            const ownedByViewer = Boolean(
                viewerHash
                && String(projected._ownerHash || '').trim() === viewerHash
            );
            projected.ownedByViewer = ownedByViewer;
            projected.canEdit = ownedByViewer;
            projected.canDelete = ownedByViewer && filtered.paragraph.variants.length > 1;
            delete projected._ownerHash;
            return projected;
        });
    }

    return filtered;
}

function normalizeChoiceOptions(options = []) {
    const seen = new Set();
    const normalized = [];
    for (const option of Array.isArray(options) ? options : []) {
        const value = String(option || '').trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        normalized.push(value);
    }
    return normalized;
}

function clampRatingMax(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 10;
    return Math.max(1, Math.min(10, parsed));
}

function createPollQuestionId(index) {
    return `q${index + 1}`;
}

function normalizePollQuestion(input = {}, index = 0) {
    const pollMode = String(input.pollMode || input.voteMode || 'choice').trim() === 'rating' ? 'rating' : 'choice';
    const ratingMax = clampRatingMax(input.ratingMax);
    const question = {
        id: String(input.id || createPollQuestionId(index)).trim() || createPollQuestionId(index),
        prompt: String(input.prompt || `Question ${index + 1}`).trim() || `Question ${index + 1}`,
        pollMode,
        ratingMax,
        options: []
    };
    if (pollMode === 'rating') {
        question.options = Array.from({ length: ratingMax }, (_, optionIndex) => String(optionIndex + 1));
        return question;
    }
    const options = normalizeChoiceOptions(input.options);
    question.options = options.length > 0 ? options : ['Yes', 'No'];
    return question;
}

function normalizePollQuestions(properties = {}) {
    const source = Array.isArray(properties.questions) ? properties.questions : [];
    const questions = source
        .map((question, index) => normalizePollQuestion(question, index))
        .filter((question) => question.prompt);
    return questions.length ? questions : [normalizePollQuestion({}, 0)];
}

function normalizePollData(data = {}, questions = []) {
    const sourceAnswers = data?.answers && typeof data.answers === 'object' && !Array.isArray(data.answers)
        ? data.answers
        : {};
    const answers = {};
    for (const question of questions) {
        const answer = String(sourceAnswers[question.id] || '').trim();
        if (!answer) {
            throw new Error(`Missing required poll answer for "${question.id}".`);
        }
        if (!question.options.includes(answer)) {
            throw new Error(`Invalid poll option "${answer}" for "${question.id}".`);
        }
        answers[question.id] = answer;
    }
    const participantName = String(data?.participantName || data?.displayName || data?.name || '').trim();
    return {
        answers,
        ...(participantName ? { participantName } : {})
    };
}

function buildPollAggregation(participantData = {}, questions = []) {
    const questionResults = {};
    for (const question of questions) {
        const counts = {};
        for (const option of question.options) {
            counts[option] = 0;
        }
        for (const entry of Object.values(participantData || {})) {
            const poll = String(entry?.answers?.[question.id] || '').trim();
            if (!poll || !Object.prototype.hasOwnProperty.call(counts, poll)) continue;
            counts[poll] += 1;
        }
        questionResults[question.id] = {
            counts,
            total: Object.values(counts).reduce((sum, count) => sum + count, 0)
        };
    }
    return {
        questions: questionResults,
        totalParticipants: Object.keys(participantData || {}).length
    };
}

function normalizePollProperties(properties = {}, { resetResponses = false } = {}) {
    const questions = normalizePollQuestions(properties);
    const questionIds = new Set(questions.map((question) => question.id));
    const durationSeconds = Math.max(0, Number.parseInt(String(properties.durationSeconds || 0), 10) || 0);
    let status = String(properties.status || (durationSeconds > 0 ? 'draft' : 'open')).trim() || 'open';
    if (!['draft', 'open', 'closed'].includes(status)) {
        status = durationSeconds > 0 ? 'draft' : 'open';
    }
    if (durationSeconds > 0 && !properties.startedAt && status !== 'closed') {
        status = 'draft';
    }
    if (durationSeconds === 0 && status === 'draft') {
        status = 'open';
    }
    const participantData = {};
    if (!resetResponses) {
        for (const [participantId, entry] of Object.entries(properties.participantData || {})) {
            const id = String(participantId || '').trim();
            const answers = {};
            for (const [questionId, answer] of Object.entries(entry?.answers || {})) {
                const normalizedQuestionId = String(questionId || '').trim();
                const normalizedAnswer = String(answer || '').trim();
                const question = questions.find((candidate) => candidate.id === normalizedQuestionId);
                if (!normalizedQuestionId || !questionIds.has(normalizedQuestionId) || !question?.options.includes(normalizedAnswer)) continue;
                answers[normalizedQuestionId] = normalizedAnswer;
            }
            if (!id || Object.keys(answers).length !== questions.length) continue;
            const participantName = String(entry?.participantName || entry?.displayName || entry?.name || '').trim();
            participantData[id] = {
                answers,
                ...(participantName ? { participantName } : {})
            };
        }
    }
    return {
        ...cloneJson(properties),
        description: String(properties.description || '').trim(),
        questions,
        allowPollChange: properties.allowPollChange === true,
        anonymous: properties.anonymous === true,
        resultsVisibility: String(properties.resultsVisibility || 'public').trim() || 'public',
        status,
        durationSeconds,
        startedAt: String(properties.startedAt || '').trim(),
        closesAt: String(properties.closesAt || '').trim(),
        participantData,
        aggregation: buildPollAggregation(participantData, questions)
    };
}

function createBulletsItemId(index) {
    return `b${index + 1}`;
}

function normalizeBulletsStatus(value = '') {
    const normalized = String(value || '').trim();
    return ['todo', 'inProgress', 'done', 'blocked'].includes(normalized) ? normalized : 'todo';
}

function normalizeBulletsPriority(value = '') {
    const normalized = String(value || '').trim();
    return ['high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
}

function normalizeBulletsItem(input = {}, index = 0) {
    return {
        id: String(input.id || createBulletsItemId(index)).trim() || createBulletsItemId(index),
        text: String(input.text || '').trim(),
        status: normalizeBulletsStatus(input.status),
        priority: normalizeBulletsPriority(input.priority)
    };
}

function normalizeBulletsProperties(properties = {}) {
    const items = (Array.isArray(properties.items) ? properties.items : [])
        .map((item, index) => normalizeBulletsItem(item, index))
        .filter((item) => item.text);
    return {
        ...cloneJson(properties),
        title: String(properties.title || 'Meeting Bullets').trim() || 'Meeting Bullets',
        meetingDateTime: String(properties.meetingDateTime || '').trim(),
        items
    };
}

function sanitizeWidgetPatch(widget, patch = {}) {
    if (widget?.type !== 'poll' || !isPlainObject(patch?.properties)) {
        return patch;
    }
    const cleanPatch = cloneJson(patch);
    delete cleanPatch.properties.participantData;
    delete cleanPatch.properties.aggregation;
    return cleanPatch;
}

function getChangeActorId(change = {}, options = {}) {
    return String(change.participantId || options.participantId || options.actorParticipantId || '').trim();
}

function translateWidget(widget, dx, dy, options = {}) {
    const geometry = widget.properties?.geometry;
    const properties = {};
    if (isPlainObject(geometry)) {
        properties.geometry = {
            ...geometry,
            x: Number(geometry.x || 0) + dx,
            y: Number(geometry.y || 0) + dy,
        };
    } else if (widget.type === 'line' && widget.properties?.line && !widget.properties?.connection) {
        const line = widget.properties.line;
        properties.line = {
            ...line,
            x1: Number(line.x1 || 0) + dx,
            y1: Number(line.y1 || 0) + dy,
            x2: Number(line.x2 || 0) + dx,
            y2: Number(line.y2 || 0) + dy,
        };
    }
    widget.patch({ properties }, options);
}

function canManagePollWidget(widget, actorId = '', options = {}) {
    if (options.canManagePoll === true || options.canModerateBlackboard === true) {
        return true;
    }
    const permissionParticipantId = String(options.permissionParticipantId || actorId || '').trim();
    const ownerParticipantId = String(widget?.properties?.ownerParticipantId || widget?.createdBy || '').trim();
    return Boolean(permissionParticipantId && ownerParticipantId && permissionParticipantId === ownerParticipantId);
}

function assertCanManagePollWidget(widget, actorId = '', options = {}) {
    if (widget?.type !== 'poll') return;
    if (!canManagePollWidget(widget, actorId, options)) {
        throw new Error('Only the poll creator or an admin can modify this poll.');
    }
}

function isPastIso(isoValue = '', nowMs = Date.now()) {
    const time = Date.parse(String(isoValue || '').trim());
    return Number.isFinite(time) && nowMs >= time;
}

export class BlackboardWidget {
    constructor(input = {}) {
        this.id = String(input.id || randomId('widget')).trim();
        this.type = normalizeWidgetType(input.type || 'shape');
        this.properties = this.type === 'line'
            ? normalizeFreeLineProperties(input.properties || {})
            : cloneJson(input.properties || {});
        this.groupId = String(input.groupId || '').trim();
        this.visibility = normalizeVisibility(input.visibility || 'all');
        this.locked = Boolean(input.locked);
        this.createdBy = String(input.createdBy || '').trim();
        this.updatedBy = String(input.updatedBy || input.createdBy || '').trim();
        this.provenance = cloneJson(input.provenance || null);
        this.createdAt = String(input.createdAt || input.timestamp || nowIso()).trim();
        this.updatedAt = String(input.updatedAt || input.timestamp || this.createdAt).trim();
        this.timestamp = String(input.timestamp || this.updatedAt).trim();
        this.runtime = input.runtime || {};
    }

    patch(patch = {}, options = {}) {
        if (this.locked && !options.canEditLocked && patch.locked === undefined) {
            throw new Error(`Blackboard widget "${this.id}" is locked.`);
        }
        if (patch.type !== undefined) {
            this.type = normalizeWidgetType(patch.type);
        }
        if (patch.properties !== undefined) {
            this.properties = mergePlainObject(this.properties, patch.properties);
        }
        if (patch.groupId !== undefined) this.groupId = String(patch.groupId || '').trim();
        if (patch.visibility !== undefined) {
            this.visibility = normalizeVisibility(patch.visibility);
        }
        if (patch.locked !== undefined) {
            this.locked = Boolean(patch.locked);
        }
        this.timestamp = String(patch.timestamp || nowIso()).trim();
        this.updatedAt = this.timestamp;
        if (options.participantId) this.updatedBy = String(options.participantId).trim();
        if (options.provenance) this.provenance = cloneJson(options.provenance);
        return this;
    }

    patchProperties(patch = {}, options = {}) {
        return this.patch({ properties: patch }, options);
    }

    setLocked(value) {
        this.locked = Boolean(value);
        this.timestamp = nowIso();
        this.updatedAt = this.timestamp;
        return this;
    }

    isVisibleFor(viewerContext = {}) {
        return isVisibleForContext(this.visibility, viewerContext);
    }

    serialize(viewerContext = {}) {
        if (!this.isVisibleFor(viewerContext)) {
            return null;
        }
        return {
            id: this.id,
            type: this.type,
            properties: filterPropertiesForViewer(this.properties, viewerContext),
            groupId: this.groupId,
            visibility: cloneJson(this.visibility),
            locked: this.locked,
            createdBy: this.createdBy,
            updatedBy: this.updatedBy,
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            timestamp: this.timestamp
        };
    }

    serializePrivileged() {
        return {
            id: this.id,
            type: this.type,
            properties: cloneJson(this.properties),
            groupId: this.groupId,
            visibility: cloneJson(this.visibility),
            locked: this.locked,
            createdBy: this.createdBy,
            updatedBy: this.updatedBy,
            provenance: cloneJson(this.provenance),
            createdAt: this.createdAt,
            updatedAt: this.updatedAt,
            timestamp: this.timestamp
        };
    }

    static from(input) {
        return input instanceof BlackboardWidget ? input : new BlackboardWidget(input);
    }
}

export class BlackboardHistory {
    constructor({ maxDepth = DEFAULT_BLACKBOARD_HISTORY_DEPTH } = {}) {
        this.maxDepth = normalizeHistoryDepth(maxDepth);
        this.undoStack = [];
        this.redoStack = [];
    }

    record(operation, beforeObject, afterObject) {
        this.undoStack.push({
            operation: String(operation || '').trim(),
            beforeObject: cloneHistorySnapshot(beforeObject),
            afterObject: cloneHistorySnapshot(afterObject),
            timestamp: nowIso()
        });
        if (this.undoStack.length > this.maxDepth) {
            this.undoStack.shift();
        }
        this.clearRedo();
    }

    clearRedo() {
        this.redoStack = [];
    }

    canUndo() {
        return this.undoStack.length > 0;
    }

    canRedo() {
        return this.redoStack.length > 0;
    }

    takeUndo() {
        const entry = this.undoStack.pop() || null;
        if (entry) {
            this.redoStack.push(entry);
        }
        return entry;
    }

    takeRedo() {
        const entry = this.redoStack.pop() || null;
        if (entry) {
            this.undoStack.push(entry);
        }
        return entry;
    }

    serialize() {
        return {
            maxDepth: this.maxDepth,
            undoStack: this.undoStack.map((entry) => ({
                ...entry,
                beforeObject: cloneHistorySnapshot(entry.beforeObject),
                afterObject: cloneHistorySnapshot(entry.afterObject)
            })),
            redoStack: this.redoStack.map((entry) => ({
                ...entry,
                beforeObject: cloneHistorySnapshot(entry.beforeObject),
                afterObject: cloneHistorySnapshot(entry.afterObject)
            }))
        };
    }

    static from(input = {}) {
        const history = new BlackboardHistory({ maxDepth: input.maxDepth });
        history.undoStack = Array.isArray(input.undoStack)
            ? input.undoStack.slice(-history.maxDepth).map((entry) => ({
                ...entry,
                beforeObject: cloneHistorySnapshot(entry?.beforeObject),
                afterObject: cloneHistorySnapshot(entry?.afterObject)
            }))
            : [];
        history.redoStack = Array.isArray(input.redoStack)
            ? input.redoStack.slice(-history.maxDepth).map((entry) => ({
                ...entry,
                beforeObject: cloneHistorySnapshot(entry?.beforeObject),
                afterObject: cloneHistorySnapshot(entry?.afterObject)
            }))
            : [];
        return history;
    }
}

export class Blackboard {
    constructor(input = {}) {
        this.roomId = String(input.roomId || '').trim();
        this.id = String(input.id || `blackboard_${this.roomId || randomId('room')}`).trim();
        this.boardId = String(input.boardId || input.metadata?.boardId || this.id).trim();
        this.boardOwnerType = String(input.boardOwnerType || input.metadata?.boardOwnerType || '').trim();
        this.boardOwnerId = String(input.boardOwnerId || input.metadata?.boardOwnerId || '').trim();
        this.boardVisibility = String(input.boardVisibility || input.metadata?.boardVisibility || 'room').trim() || 'room';
        this.revision = Number.isFinite(input.revision) ? input.revision : 0;
        this.interactionContext = {
            focusedWidgetId: String(input.interactionContext?.focusedWidgetId || '').trim(),
            lastAffectedWidgetIds: Array.isArray(input.interactionContext?.lastAffectedWidgetIds)
                ? input.interactionContext.lastAffectedWidgetIds.map((id) => String(id || '').trim()).filter(Boolean)
                : [],
            updatedBy: String(input.interactionContext?.updatedBy || '').trim(),
            updatedAt: String(input.interactionContext?.updatedAt || '').trim(),
        };
        this.metadata = cloneJson(input.metadata || {});
        this.widgets = new Map();
        this.runtime = input.runtime || {};
        this.history = input.history instanceof BlackboardHistory
            ? input.history
            : BlackboardHistory.from(input.history || { maxDepth: input.maxHistoryDepth });

        const widgets = input.widgets instanceof Map ? [...input.widgets.values()] : input.widgets || [];
        for (const widget of widgets) {
            const normalized = BlackboardWidget.from(widget);
            this.widgets.set(normalized.id, normalized);
        }
    }

    addWidget(widget, options = {}) {
        const normalized = BlackboardWidget.from(widget);
        if (this.widgets.has(normalized.id)) {
            throw new Error(`Blackboard widget "${normalized.id}" already exists.`);
        }
        if (options.participantId) {
            normalized.createdBy = String(options.participantId || '').trim();
            normalized.updatedBy = normalized.createdBy;
        }
        if (options.provenance) normalized.provenance = cloneJson(options.provenance);
        if (normalized.type === 'poll') {
            const ownerParticipantId = String(options.ownerParticipantId || normalized.properties?.ownerParticipantId || normalized.createdBy || options.participantId || '').trim();
            normalized.properties = {
                ...normalized.properties,
                ownerParticipantId
            };
            normalized.properties = normalizePollProperties(normalized.properties, { resetResponses: true });
        } else if (normalized.type === 'bullets') {
            normalized.properties = normalizeBulletsProperties(normalized.properties);
        }
        this.widgets.set(normalized.id, normalized);
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('create', null, normalized.serializePrivileged());
        }
        return normalized;
    }

    getWidget(widgetId) {
        return this.widgets.get(String(widgetId || '').trim()) || null;
    }

    patchWidget(widgetId, patch = {}, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            throw new Error(`Blackboard widget "${widgetId}" was not found.`);
        }
        assertCanManagePollWidget(widget, String(options.participantId || '').trim(), options);
        if (widget.properties?.closed && !options.canEditClosed) {
            throw new Error(`Blackboard widget "${widgetId}" is closed.`);
        }
        const before = widget.serializePrivileged();
        const cleanPatch = sanitizeWidgetPatch(widget, patch);
        const delta = cleanPatch?.properties?.geometryDelta;
        if (delta && typeof delta === 'object') {
            const dx = Number(delta.x || 0);
            const dy = Number(delta.y || 0);
            delete cleanPatch.properties.geometryDelta;
            translateWidget(widget, dx, dy, options);
            if (widget.groupId) {
                for (const member of this.widgets.values()) {
                    if (member.id !== widget.id && member.groupId === widget.groupId) {
                        translateWidget(member, dx, dy, options);
                    }
                }
            }
        }
        if (!delta && options.moveGroup && widget.groupId && cleanPatch?.properties?.geometry) {
            const current = widget.properties?.geometry || {};
            const next = cleanPatch.properties.geometry;
            const dx = Number(next.x ?? current.x ?? 0) - Number(current.x || 0);
            const dy = Number(next.y ?? current.y ?? 0) - Number(current.y || 0);
            for (const member of this.widgets.values()) {
                if (member.id !== widget.id && member.groupId === widget.groupId) translateWidget(member, dx, dy, options);
            }
        }
        if (Object.keys(cleanPatch || {}).some((key) => key !== 'properties' || Object.keys(cleanPatch.properties || {}).length)) {
            widget.patch(cleanPatch, options);
        }
        if (widget.type === 'poll') {
            widget.properties = normalizePollProperties(widget.properties);
        } else if (widget.type === 'bullets') {
            widget.properties = normalizeBulletsProperties(widget.properties);
        }
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('patch', before, widget.serializePrivileged());
        }
        return widget;
    }

    removeWidget(widgetId, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            const error = new Error(`Blackboard widget "${widgetId}" was not found.`);
            error.code = 'widget_not_found';
            throw error;
        }
        assertCanManagePollWidget(widget, String(options.participantId || '').trim(), options);
        this.widgets.delete(widget.id);
        for (const candidate of [...this.widgets.values()]) {
            const connection = candidate.properties?.connection;
            if (connection?.from?.widgetId === widget.id || connection?.to?.widgetId === widget.id) {
                this.widgets.delete(candidate.id);
            }
        }
        this.dissolveSingletonGroups();
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('delete', widget.serializePrivileged(), null);
        }
        return widget;
    }

    clear(options = {}) {
        const before = this.serializePrivileged();
        this.widgets.clear();
        this.interactionContext = { focusedWidgetId: '', lastAffectedWidgetIds: [], updatedBy: '', updatedAt: nowIso() };
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('clear', before, this.serializePrivileged());
        }
        return this;
    }

    patch(patch = {}, options = {}) {
        const before = this.serializePrivileged();
        if (patch.metadata !== undefined) {
            this.metadata = mergePlainObject(this.metadata, patch.metadata);
        }
        if (patch.resetThemeStyles === true) {
            for (const widget of this.widgets.values()) {
                resetThemeStyleProperties(widget.properties, widget.type);
            }
        }
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('patchBlackboard', before, this.serializePrivileged());
        }
        return this;
    }

    submitParticipantData(widgetId, participantId, data, options = {}) {
        const id = String(participantId || '').trim();
        if (!id) {
            throw new Error('Missing blackboard participant id.');
        }
        const widget = this.getWidget(widgetId);
        if (!widget) {
            throw new Error(`Blackboard widget "${widgetId}" was not found.`);
        }
        const before = widget.serializePrivileged();
        if (widget.type === 'poll') {
            const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
            if (widget.properties.status !== 'open') {
                throw new Error('Poll is not open.');
            }
            if (widget.properties.closesAt && isPastIso(widget.properties.closesAt, nowMs)) {
                widget.patchProperties({ status: 'closed' }, { ...options, canEditLocked: true });
                this.bumpRevision(options.revision);
                throw new Error('Poll is closed.');
            }
            const questions = normalizePollQuestions(widget.properties);
            const pollData = normalizePollData(data, questions);
            const participantData = widget.properties.participantData || {};
            if (participantData[id] && widget.properties.allowPollChange !== true) {
                throw new Error('Poll cannot be changed for this widget.');
            }
            const nextParticipantData = {
                ...participantData,
                [id]: pollData
            };
            widget.patchProperties({
                participantData: nextParticipantData,
                aggregation: buildPollAggregation(nextParticipantData, questions)
            }, { ...options, canEditLocked: options.canEditLocked ?? true });
            this.bumpRevision(options.revision);
            if (options.record !== false && options.undoable !== false) {
                this.history.record('submit', before, widget.serializePrivileged());
            }
            return widget;
        }
        widget.patchProperties({
            participantData: {
                ...(widget.properties.participantData || {}),
                [id]: cloneJson(data)
            }
        }, { ...options, canEditLocked: options.canEditLocked ?? true });
        this.bumpRevision(options.revision);
        if (options.record !== false && options.undoable !== false) {
            this.history.record('submit', before, widget.serializePrivileged());
        }
        return widget;
    }

    startPoll(widgetId, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            throw new Error(`Blackboard widget "${widgetId}" was not found.`);
        }
        if (widget.type !== 'poll') {
            throw new Error(`Blackboard widget "${widgetId}" is not a poll.`);
        }
        assertCanManagePollWidget(widget, String(options.participantId || '').trim(), options);
        const before = widget.serializePrivileged();
        const startedAt = String(options.nowIso || nowIso()).trim();
        const durationSeconds = Math.max(0, Number.parseInt(String(widget.properties.durationSeconds || 0), 10) || 0);
        const closesAt = durationSeconds > 0
            ? new Date(Date.parse(startedAt) + durationSeconds * 1000).toISOString()
            : '';
        widget.patchProperties({
            status: 'open',
            startedAt,
            closesAt
        }, { ...options, canEditLocked: true, canEditClosed: true });
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('startPoll', before, widget.serializePrivileged());
        }
        return widget;
    }

    closePoll(widgetId, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            throw new Error(`Blackboard widget "${widgetId}" was not found.`);
        }
        if (widget.type !== 'poll') {
            throw new Error(`Blackboard widget "${widgetId}" is not a poll.`);
        }
        assertCanManagePollWidget(widget, String(options.participantId || '').trim(), options);
        const before = widget.serializePrivileged();
        widget.patchProperties({ status: 'closed' }, { ...options, canEditLocked: true, canEditClosed: true });
        this.bumpRevision(options.revision);
        if (options.record !== false) {
            this.history.record('closePoll', before, widget.serializePrivileged());
        }
        return widget;
    }

    undo(viewerContext = {}) {
        const entry = this.history.takeUndo();
        if (!entry) {
            return null;
        }
        this.applyHistoryEntry(entry, 'undo');
        this.bumpRevision();
        return this.serialize(viewerContext);
    }

    redo(viewerContext = {}) {
        const entry = this.history.takeRedo();
        if (!entry) {
            return null;
        }
        this.applyHistoryEntry(entry, 'redo');
        this.bumpRevision();
        return this.serialize(viewerContext);
    }

    applyHistoryEntry(entry, direction) {
        const object = direction === 'undo' ? entry.beforeObject : entry.afterObject;
        if (entry.operation === 'clear' || entry.operation === 'command') {
            const history = this.history;
            this.replaceFromSerialized(object || { roomId: this.roomId, widgets: [] });
            this.history = history;
            return;
        }
        if (entry.operation === 'patchBlackboard') {
            const history = this.history;
            this.replaceFromSerialized(object || { roomId: this.roomId, widgets: [] });
            this.history = history;
            return;
        }
        if (entry.operation === 'create' && direction === 'undo') {
            this.widgets.delete(entry.afterObject.id);
            return;
        }
        if (entry.operation === 'delete' && direction === 'redo') {
            this.widgets.delete(entry.beforeObject.id);
            return;
        }
        if (object?.id) {
            this.widgets.set(object.id, BlackboardWidget.from(object));
        }
    }

    applyFinalChange(change = {}, options = {}) {
        const changeType = String(change.changeType || '').trim();
        if (!BLACKBOARD_CHANGE_TYPES.includes(changeType)) {
            throw new Error(`Unsupported blackboard change type "${changeType}".`);
        }
        if (changeType === 'create') {
            return this.addWidget(change.widget || change.object, { ...options, participantId: getChangeActorId(change, options) });
        }
        if (changeType === 'clear') {
            return this.clear(options);
        }
        if (changeType === 'group') {
            return this.groupWidgets(change.widgetIds || change.data?.widgetIds, options);
        }
        if (changeType === 'update' && String(change.targetType || '').trim() === 'blackboard') {
            return this.patch(change.patch || {}, options);
        }
        const targetRef = String(change.targetRef || change.widgetId || '').trim();
        if (!targetRef) {
            throw new Error('Missing blackboard widget target.');
        }
        if (changeType === 'delete') {
            return this.removeWidget(targetRef, { ...options, participantId: getChangeActorId(change, options) });
        }
        if (changeType === 'ungroup') return this.ungroupWidget(targetRef, options);
        if (changeType === 'focus') return this.focusWidget(targetRef, options);
        if (changeType === 'submit') {
            return this.submitParticipantData(targetRef, change.participantId, change.data, options);
        }
        if (changeType === 'start') {
            return this.startPoll(targetRef, { ...options, participantId: getChangeActorId(change, options) });
        }
        if (changeType === 'close') {
            return this.closePoll(targetRef, { ...options, participantId: getChangeActorId(change, options) });
        }
        return this.patchWidget(targetRef, change.patch || {}, { ...options, participantId: getChangeActorId(change, options) });
    }

    groupWidgets(widgetIds = [], options = {}) {
        const ids = [...new Set((Array.isArray(widgetIds) ? widgetIds : []).map((id) => String(id || '').trim()).filter(Boolean))];
        if (ids.length < 2) throw new Error('A group requires at least two widgets.');
        const widgets = ids.map((id) => {
            const widget = this.getWidget(id);
            if (!widget) {
                const error = new Error(`Blackboard widget "${id}" was not found.`);
                error.code = 'widget_not_found';
                throw error;
            }
            if (widget.groupId) throw new Error(`Blackboard widget "${id}" already belongs to a group.`);
            return widget;
        });
        const groupId = String(options.groupId || randomId('group')).trim();
        widgets.forEach((widget) => { widget.groupId = groupId; });
        this.bumpRevision(options.revision);
        return widgets;
    }

    ungroupWidget(widgetId, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            const error = new Error(`Blackboard widget "${widgetId}" was not found.`);
            error.code = 'widget_not_found';
            throw error;
        }
        const groupId = widget.groupId;
        if (groupId) for (const member of this.widgets.values()) if (member.groupId === groupId) member.groupId = '';
        this.bumpRevision(options.revision);
        return widget;
    }

    dissolveSingletonGroups() {
        const counts = new Map();
        for (const widget of this.widgets.values()) if (widget.groupId) counts.set(widget.groupId, (counts.get(widget.groupId) || 0) + 1);
        for (const widget of this.widgets.values()) if (widget.groupId && counts.get(widget.groupId) < 2) widget.groupId = '';
    }

    focusWidget(widgetId, options = {}) {
        const id = String(widgetId || '').trim();
        if (id && !this.getWidget(id)) {
            const error = new Error(`Blackboard widget "${id}" was not found.`);
            error.code = 'widget_not_found';
            throw error;
        }
        this.interactionContext = {
            focusedWidgetId: id,
            lastAffectedWidgetIds: id ? [id] : [],
            updatedBy: String(options.participantId || '').trim(),
            updatedAt: nowIso(),
        };
        this.bumpRevision(options.revision);
        return id ? this.getWidget(id) : this;
    }

    updateInteractionContext(widgetIds = [], options = {}) {
        const ids = [...new Set(widgetIds.map((id) => String(id || '').trim()).filter((id) => this.widgets.has(id)))];
        this.interactionContext = {
            focusedWidgetId: ids.at(-1) || '',
            lastAffectedWidgetIds: ids,
            updatedBy: String(options.participantId || '').trim(),
            updatedAt: nowIso(),
        };
    }

    bumpRevision(explicitRevision) {
        this.revision = Number.isFinite(explicitRevision) ? Math.max(this.revision, explicitRevision) : this.revision + 1;
    }

    serialize(viewerContext = {}) {
        return {
            boardId: this.boardId,
            revision: this.revision,
            interactionContext: cloneJson(this.interactionContext),
            widgets: [...this.widgets.values()]
                .map((widget) => widget.serialize(viewerContext))
                .filter(Boolean)
        };
    }

    serializePrivileged() {
        return {
            id: this.id,
            roomId: this.roomId,
            boardId: this.boardId,
            boardOwnerType: this.boardOwnerType,
            boardOwnerId: this.boardOwnerId,
            boardVisibility: this.boardVisibility,
            revision: this.revision,
            interactionContext: cloneJson(this.interactionContext),
            metadata: cloneJson(this.metadata),
            widgets: [...this.widgets.values()].map((widget) => widget.serializePrivileged()),
            history: this.history.serialize()
        };
    }

    replaceFromSerialized(serialized) {
        const next = Blackboard.from(serialized);
        this.id = next.id;
        this.roomId = next.roomId;
        this.boardId = next.boardId;
        this.boardOwnerType = next.boardOwnerType;
        this.boardOwnerId = next.boardOwnerId;
        this.boardVisibility = next.boardVisibility;
        this.revision = next.revision;
        this.interactionContext = next.interactionContext;
        this.metadata = next.metadata;
        this.widgets = next.widgets;
        this.history = next.history;
        return this;
    }

    static from(input) {
        return input instanceof Blackboard ? input : new Blackboard(input);
    }
}

export function createBlackboardWidget(type, properties = {}, options = {}) {
    return new BlackboardWidget({ ...options, type, properties });
}
