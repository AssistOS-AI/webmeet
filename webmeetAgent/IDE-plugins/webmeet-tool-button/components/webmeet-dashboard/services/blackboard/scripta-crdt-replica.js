const AUTOMERGE_MODULE_URL = '/explorer/shared/vendor/automerge/dist/mjs/entrypoints/fullfat_base64.js';

let automergePromise = null;

function getAutomerge() {
    automergePromise ||= import(AUTOMERGE_MODULE_URL);
    return automergePromise;
}

function actorId() {
    const value = globalThis.crypto?.randomUUID?.().replace(/-/g, '');
    return value || `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.padEnd(32, '0').slice(0, 32);
}

function bytesFromBase64(value) {
    const text = String(value || '');
    const binary = globalThis.atob(text);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64FromBytes(value) {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return globalThis.btoa(binary);
}

function selectedVariant(draft, chapterId, paragraphId, variantId) {
    const chapter = (draft.chapters || []).find((entry) => entry.id === chapterId);
    const paragraph = (chapter?.paragraphs || []).find((entry) => entry.id === paragraphId);
    const variants = paragraph?.pluginState?.scripta?.variants || [];
    return variants.find((entry) => entry.id === variantId) || null;
}

function sameHeads(left = [], right = []) {
    const first = [...left].map(String).sort();
    const second = [...right].map(String).sort();
    return first.length === second.length && first.every((head, index) => head === second[index]);
}

export class ScriptaCrdtReplica {
    constructor(adapter, { loadAutomerge = getAutomerge, createActorId = actorId } = {}) {
        this.adapter = adapter;
        this.loadAutomerge = loadAutomerge;
        this.createActorId = createActorId;
        this.clientId = createActorId();
        this.sessions = new Map();
        this.pullQueue = Promise.resolve([]);
        this.mutationQueues = new Map();
    }

    async requestSnapshot(resourceId) {
        return this.adapter.runTool('webmeet_scripta_sync_open', {
            roomId: this.adapter.roomId,
            resourceId,
            clientId: this.clientId,
            participantId: this.adapter.participantId,
        });
    }

    async open(resourceId) {
        const key = String(resourceId || '');
        if (!key) throw new Error('Missing SCRIPTA resource id.');
        const current = this.sessions.get(key);
        if (current) return await current;
        const pending = (async () => {
            const response = await this.requestSnapshot(key);
            const Automerge = await this.loadAutomerge();
            return {
                resourceId: key,
                sessionId: response.sessionId,
                document: Automerge.load(bytesFromBase64(response.stateBase64), {actor: this.createActorId()}),
                heads: response.heads || [],
            };
        })();
        this.sessions.set(key, pending);
        try {
            const session = await pending;
            if (this.sessions.get(key) === pending) this.sessions.set(key, session);
            return session;
        } catch (error) {
            if (this.sessions.get(key) === pending) this.sessions.delete(key);
            throw error;
        }
    }

    async editVariant(input = {}) {
        const key = String(input.resourceId || '');
        if (!key) throw new Error('Missing SCRIPTA resource id.');
        const previous = this.mutationQueues.get(key) || Promise.resolve();
        const pending = previous
            .catch(() => {})
            .then(() => this.editVariantNow(input));
        this.mutationQueues.set(key, pending);
        try {
            return await pending;
        } finally {
            if (this.mutationQueues.get(key) === pending) {
                this.mutationQueues.delete(key);
            }
        }
    }

    async editVariantNow({resourceId, chapterId, paragraphId, variantId, text}) {
        await this.pullQueue;
        const session = await this.open(resourceId);
        const Automerge = await this.loadAutomerge();
        const before = session.document;
        const next = Automerge.change(before, (draft) => {
            const variant = selectedVariant(draft, chapterId, paragraphId, variantId);
            if (!variant) throw new Error('SCRIPTA variant was not found in the local replica.');
            const chapterIndex = (draft.chapters || []).findIndex((entry) => entry.id === chapterId);
            const paragraphIndex = (draft.chapters?.[chapterIndex]?.paragraphs || [])
                .findIndex((entry) => entry.id === paragraphId);
            const variantIndex = (draft.chapters?.[chapterIndex]?.paragraphs?.[paragraphIndex]
                ?.pluginState?.scripta?.variants || []).findIndex((entry) => entry.id === variantId);
            Automerge.updateText(draft, [
                'chapters', chapterIndex,
                'paragraphs', paragraphIndex,
                'pluginState', 'scripta', 'variants', variantIndex,
                'text',
            ], String(text ?? ''));
        });
        const changesBase64 = Automerge.getChanges(before, next).map(base64FromBytes);
        session.document = next;
        let response;
        try {
            response = await this.adapter.runTool('webmeet_scripta_sync_apply', {
                roomId: this.adapter.roomId,
                resourceId: session.resourceId,
                clientId: this.clientId,
                sessionId: session.sessionId,
                participantId: this.adapter.participantId,
                operation: 'p-variant-edit',
                args: {chapterId, paragraphId, variantId, text: String(text ?? '')},
                changesBase64,
                baseHeads: session.heads,
            });
        } catch (error) {
            try {
                const snapshot = await this.requestSnapshot(session.resourceId);
                session.sessionId = snapshot.sessionId || session.sessionId;
                session.document = Automerge.load(bytesFromBase64(snapshot.stateBase64), {actor: this.createActorId()});
                session.heads = snapshot.heads || Automerge.getHeads(session.document);
            } catch {}
            throw error;
        }
        let resetRequired = response.resetRequired || !Array.isArray(response.changesBase64);
        if (!resetRequired) {
            try {
                session.document = Automerge.applyChanges(
                    next,
                    response.changesBase64.map(bytesFromBase64)
                )[0];
            } catch {
                resetRequired = true;
            }
        }
        if (
            !resetRequired
            && Array.isArray(response.heads)
            && !sameHeads(Automerge.getHeads(session.document), response.heads)
        ) {
            resetRequired = true;
        }
        if (resetRequired) {
            const snapshot = typeof response.stateBase64 === 'string'
                ? response
                : await this.requestSnapshot(session.resourceId);
            session.sessionId = snapshot.sessionId || session.sessionId;
            session.document = Automerge.load(bytesFromBase64(snapshot.stateBase64), {actor: this.createActorId()});
            session.heads = snapshot.heads || Automerge.getHeads(session.document);
        } else {
            session.heads = response.heads || Automerge.getHeads(session.document);
        }
        return response;
    }

    async pull(resourceId) {
        const session = await this.open(resourceId);
        const response = await this.adapter.runTool('webmeet_scripta_sync_pull', {
            roomId: this.adapter.roomId,
            resourceId: session.resourceId,
            clientId: this.clientId,
            sessionId: session.sessionId,
            participantId: this.adapter.participantId,
            knownHeads: session.heads,
        });
        const Automerge = await this.loadAutomerge();
        let resetRequired = response.resetRequired || !Array.isArray(response.changesBase64);
        if (!resetRequired && response.changesBase64.length) {
            try {
                session.document = Automerge.applyChanges(
                    session.document,
                    response.changesBase64.map(bytesFromBase64)
                )[0];
            } catch {
                resetRequired = true;
            }
        }
        if (
            !resetRequired
            && Array.isArray(response.heads)
            && !sameHeads(Automerge.getHeads(session.document), response.heads)
        ) {
            resetRequired = true;
        }
        if (resetRequired) {
            const snapshot = typeof response.stateBase64 === 'string'
                ? response
                : await this.requestSnapshot(session.resourceId);
            session.sessionId = snapshot.sessionId || session.sessionId;
            session.document = Automerge.load(bytesFromBase64(snapshot.stateBase64), {actor: this.createActorId()});
            session.heads = snapshot.heads || Automerge.getHeads(session.document);
            return {
                ...response,
                resetRequired: true
            };
        }
        session.heads = response.heads || Automerge.getHeads(session.document);
        return response;
    }

    async pullAll() {
        return Promise.allSettled([...this.sessions.keys()].map((resourceId) => this.pull(resourceId)));
    }

    schedulePullAll() {
        this.pullQueue = this.pullQueue
            .catch(() => [])
            .then(() => this.pullAll());
        return this.pullQueue;
    }

    async closeAll() {
        await this.pullQueue.catch(() => {});
        await Promise.allSettled([...this.mutationQueues.values()]);
        const pendingSessions = [...this.sessions.values()];
        this.sessions.clear();
        const results = await Promise.allSettled(pendingSessions.map((session) => Promise.resolve(session)));
        const sessions = results
            .filter((result) => result.status === 'fulfilled')
            .map((result) => result.value);
        await Promise.allSettled(sessions.map((session) => this.adapter.runTool('webmeet_scripta_sync_close', {
            roomId: this.adapter.roomId,
            resourceId: session.resourceId,
            clientId: this.clientId,
            sessionId: session.sessionId,
            participantId: this.adapter.participantId,
        })));
    }
}
