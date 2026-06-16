export const BLACKBOARD_WIDGET_TYPES = Object.freeze([
    'shape',
    'line',
    'text',
    'image',
    'card',
    'quiz',
    'vote',
    'input',
    'embed'
]);

export const BLACKBOARD_CHANGE_TYPES = Object.freeze([
    'create',
    'update',
    'delete',
    'submit',
    'reorder',
    'lock',
    'unlock',
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

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
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

function normalizeWidgetType(type) {
    const normalized = String(type || '').trim();
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
    if (resultsVisibility === 'afterSubmit' || resultsVisibility === 'afterVote') {
        const participantId = getViewerParticipantId(viewerContext);
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
    const privileged = isPrivilegedViewer(viewerContext);
    const aggregationVisible = canSeeAggregation(filtered, viewerContext);

    if (filtered.participantData && !privileged) {
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

    return filtered;
}

export class BlackboardWidget {
    constructor(input = {}) {
        this.id = String(input.id || randomId('widget')).trim();
        this.type = normalizeWidgetType(input.type || 'shape');
        this.properties = cloneJson(input.properties || {});
        this.visibility = normalizeVisibility(input.visibility || 'all');
        this.locked = Boolean(input.locked);
        this.version = Number.isFinite(input.version) ? input.version : 1;
        this.createdBy = String(input.createdBy || '').trim();
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
        if (patch.visibility !== undefined) {
            this.visibility = normalizeVisibility(patch.visibility);
        }
        if (patch.locked !== undefined) {
            this.locked = Boolean(patch.locked);
        }
        this.version = Number.isFinite(patch.version) && options.acceptRemoteVersion
            ? patch.version
            : this.version + 1;
        this.timestamp = String(patch.timestamp || nowIso()).trim();
        this.updatedAt = this.timestamp;
        return this;
    }

    patchProperties(patch = {}, options = {}) {
        return this.patch({ properties: patch }, options);
    }

    setLocked(value) {
        this.locked = Boolean(value);
        this.version += 1;
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
            visibility: cloneJson(this.visibility),
            locked: this.locked,
            version: this.version,
            createdBy: this.createdBy,
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
            visibility: cloneJson(this.visibility),
            locked: this.locked,
            version: this.version,
            createdBy: this.createdBy,
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
            beforeObject: cloneJson(beforeObject),
            afterObject: cloneJson(afterObject),
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
            undoStack: cloneJson(this.undoStack),
            redoStack: cloneJson(this.redoStack)
        };
    }

    static from(input = {}) {
        const history = new BlackboardHistory({ maxDepth: input.maxDepth });
        history.undoStack = Array.isArray(input.undoStack) ? cloneJson(input.undoStack) : [];
        history.redoStack = Array.isArray(input.redoStack) ? cloneJson(input.redoStack) : [];
        return history;
    }
}

export class Blackboard {
    constructor(input = {}) {
        this.roomId = String(input.roomId || '').trim();
        this.id = String(input.id || `blackboard_${this.roomId || randomId('room')}`).trim();
        this.version = Number.isFinite(input.version) ? input.version : 0;
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
        this.widgets.set(normalized.id, normalized);
        this.bumpVersion(options.blackboardVersion);
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
        if (widget.properties?.closed && !options.canEditClosed) {
            throw new Error(`Blackboard widget "${widgetId}" is closed.`);
        }
        const before = widget.serializePrivileged();
        widget.patch(patch, options);
        this.bumpVersion(options.blackboardVersion);
        if (options.record !== false) {
            this.history.record('patch', before, widget.serializePrivileged());
        }
        return widget;
    }

    removeWidget(widgetId, options = {}) {
        const widget = this.getWidget(widgetId);
        if (!widget) {
            return null;
        }
        this.widgets.delete(widget.id);
        this.bumpVersion(options.blackboardVersion);
        if (options.record !== false) {
            this.history.record('delete', widget.serializePrivileged(), null);
        }
        return widget;
    }

    clear(options = {}) {
        const before = this.serializePrivileged();
        this.widgets.clear();
        this.bumpVersion(options.blackboardVersion);
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
        this.bumpVersion(options.blackboardVersion);
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
        widget.patchProperties({
            participantData: {
                ...(widget.properties.participantData || {}),
                [id]: cloneJson(data)
            }
        }, { ...options, canEditLocked: options.canEditLocked ?? true });
        this.bumpVersion(options.blackboardVersion);
        if (options.record !== false && options.undoable !== false) {
            this.history.record('submit', before, widget.serializePrivileged());
        }
        return widget;
    }

    undo(viewerContext = {}) {
        const entry = this.history.takeUndo();
        if (!entry) {
            return null;
        }
        this.applyHistoryEntry(entry, 'undo');
        this.bumpVersion();
        return this.serialize(viewerContext);
    }

    redo(viewerContext = {}) {
        const entry = this.history.takeRedo();
        if (!entry) {
            return null;
        }
        this.applyHistoryEntry(entry, 'redo');
        this.bumpVersion();
        return this.serialize(viewerContext);
    }

    applyHistoryEntry(entry, direction) {
        const object = direction === 'undo' ? entry.beforeObject : entry.afterObject;
        if (entry.operation === 'clear') {
            this.replaceFromSerialized(object || { roomId: this.roomId, widgets: [] });
            return;
        }
        if (entry.operation === 'patchBlackboard') {
            this.replaceFromSerialized(object || { roomId: this.roomId, widgets: [] });
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
            return this.addWidget(change.widget || change.object, options);
        }
        if (changeType === 'clear') {
            return this.clear(options);
        }
        if (changeType === 'update' && String(change.targetType || '').trim() === 'blackboard') {
            return this.patch(change.patch || {}, options);
        }
        const targetRef = String(change.targetRef || change.widgetId || '').trim();
        if (!targetRef) {
            throw new Error('Missing blackboard widget target.');
        }
        if (changeType === 'delete') {
            return this.removeWidget(targetRef, options);
        }
        if (changeType === 'submit') {
            return this.submitParticipantData(targetRef, change.participantId, change.data, options);
        }
        if (changeType === 'lock' || changeType === 'unlock') {
            return this.patchWidget(targetRef, { locked: changeType === 'lock' }, { ...options, canEditLocked: true });
        }
        return this.patchWidget(targetRef, change.patch || {}, options);
    }

    bumpVersion(explicitVersion) {
        this.version = Number.isFinite(explicitVersion) ? Math.max(this.version, explicitVersion) : this.version + 1;
    }

    serialize(viewerContext = {}) {
        return {
            id: this.id,
            roomId: this.roomId,
            version: this.version,
            metadata: cloneJson(this.metadata),
            widgets: [...this.widgets.values()]
                .map((widget) => widget.serialize(viewerContext))
                .filter(Boolean)
        };
    }

    serializePrivileged() {
        return {
            id: this.id,
            roomId: this.roomId,
            version: this.version,
            metadata: cloneJson(this.metadata),
            widgets: [...this.widgets.values()].map((widget) => widget.serializePrivileged()),
            history: this.history.serialize()
        };
    }

    replaceFromSerialized(serialized) {
        const next = Blackboard.from(serialized);
        this.id = next.id;
        this.roomId = next.roomId;
        this.version = next.version;
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
