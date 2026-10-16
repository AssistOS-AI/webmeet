import test from 'node:test';
import assert from 'node:assert/strict';

import { ScriptaCrdtReplica } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/blackboard/scripta-crdt-replica.js';
import { BlackboardNetworkAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/blackboard/blackboard-network-adapter.js';
import {
    WEBMEET_EVENT_TYPES,
    buildWebMeetEvent,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

const fakeAutomerge = {
    load: () => ({ document: true }),
};

test('concurrent SCRIPTA replica opens share one MCP request', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const adapter = {
        roomId: 'room-1',
        participantId: 'participant-1',
        async runTool(name) {
            assert.equal(name, 'webmeet_scripta_sync_open');
            calls += 1;
            await gate;
            return {
                sessionId: 'session-1',
                stateBase64: 'AA==',
                heads: ['head-1'],
            };
        },
    };
    const replica = new ScriptaCrdtReplica(adapter, {
        loadAutomerge: async () => fakeAutomerge,
        createActorId: () => 'actor-1',
    });

    const first = replica.open('resource-1');
    const second = replica.open('resource-1');
    release();
    const [left, right] = await Promise.all([first, second]);

    assert.equal(calls, 1);
    assert.equal(left, right);
});

test('SCRIPTA variant edits are serialized per document', async () => {
    const calls = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const initialDocument = {
        chapters: [{
            id: 'chapter-1',
            paragraphs: [{
                id: 'paragraph-1',
                pluginState: {
                    scripta: {
                        variants: [{id: 'variant-1', text: 'Initial'}],
                    },
                },
            }],
        }],
        heads: ['head-initial'],
    };
    const automerge = {
        load() {
            return structuredClone(initialDocument);
        },
        updateText(document, objectPath, value) {
            const property = objectPath.at(-1);
            const target = objectPath.slice(0, -1).reduce((current, segment) => current[segment], document);
            target[property] = String(value);
        },
        change(document, callback) {
            const next = structuredClone(document);
            callback(next);
            const text = next.chapters[0].paragraphs[0].pluginState.scripta.variants[0].text;
            next.heads = [`head-${text}`];
            return next;
        },
        getChanges(_before, next) {
            return [Uint8Array.from([next.heads[0].length])];
        },
        applyChanges(document) {
            return [document];
        },
        getHeads(document) {
            return document.heads;
        },
    };
    const adapter = {
        roomId: 'room-1',
        participantId: 'participant-1',
        async runTool(name, args) {
            if (name === 'webmeet_scripta_sync_open') {
                return {
                    sessionId: 'session-1',
                    stateBase64: 'AA==',
                    heads: ['head-initial'],
                };
            }
            assert.equal(name, 'webmeet_scripta_sync_apply');
            calls.push(args.args.text);
            if (calls.length === 1) await firstGate;
            return {
                changesBase64: [],
                heads: [`head-${args.args.text}`],
                resetRequired: false,
            };
        },
    };
    const replica = new ScriptaCrdtReplica(adapter, {
        loadAutomerge: async () => automerge,
        createActorId: () => 'actor-1',
    });

    const first = replica.editVariant({
        resourceId: 'resource-1',
        chapterId: 'chapter-1',
        paragraphId: 'paragraph-1',
        variantId: 'variant-1',
        text: 'First',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = replica.editVariant({
        resourceId: 'resource-1',
        chapterId: 'chapter-1',
        paragraphId: 'paragraph-1',
        variantId: 'variant-1',
        text: 'Second',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(calls, ['First']);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(calls, ['First', 'Second']);
    assert.deepEqual((await replica.open('resource-1')).heads, ['head-Second']);
});

test('wrong-board updates do not pull SCRIPTA replicas', async () => {
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room-1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant-1',
        runTool: async () => ({}),
    });
    let pulls = 0;
    adapter.scriptaReplica.pullAll = async () => { pulls += 1; };

    const result = await adapter.handleEncodedEvent(buildWebMeetEvent(
        'room-1',
        WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED,
        {
            meetingId: 'room-1',
            boardId: 'agent:another_agent',
            blackboardRevision: 3,
            changeType: 'update',
        }
    ));

    assert.equal(result, 'wrong-board');
    assert.equal(pulls, 0);
});

test('local SCRIPTA events publish immediately and synchronize cached replicas in the background', async () => {
    const order = [];
    let releasePull;
    const pullGate = new Promise((resolve) => { releasePull = resolve; });
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room-1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant-1',
        runTool: async () => ({
            ok: true,
            blackboard: { version: 2, revision: 2, widgets: [] },
        }),
        publishRealtimePayload: async () => {},
    });
    adapter.scriptaReplica.pullAll = async () => {
        order.push('pull');
        await pullGate;
        return [];
    };
    adapter.publishFinalUpdate = async () => {
        order.push('publish');
    };

    await adapter.sendEvent('scripta-chapter-add', {}, {
        widgetId: 'robo_scripta_document',
    });

    assert.deepEqual(order, ['publish']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(order, ['publish', 'pull']);
    releasePull();
    await adapter.scriptaReplica.pullQueue;
});

test('SCRIPTA view navigation does not pull an unchanged document replica', async () => {
    const adapter = new BlackboardNetworkAdapter({
        roomId: 'room-1',
        boardId: 'agent:agent_robo_team',
        participantId: 'participant-1',
        runTool: async () => ({
            ok: true,
            blackboard: { version: 2, widgets: [] },
        }),
        publishRealtimePayload: async () => {},
    });
    let pulls = 0;
    adapter.scriptaReplica.pullAll = async () => {
        pulls += 1;
        return [];
    };

    await adapter.sendEvent('scripta-paragraph-open', {
        chapterId: 'chapter-1',
        paragraphId: 'paragraph-1',
    }, {
        widgetId: 'robo_scripta_document',
    });

    assert.equal(pulls, 0);
});

test('a failed incremental pull resets the browser replica from the authoritative snapshot', async () => {
    let openCalls = 0;
    const automerge = {
        load(bytes) {
            return bytes[0] === 2
                ? { state: 'latest', heads: ['head-2'] }
                : { state: 'initial', heads: ['head-1'] };
        },
        applyChanges() {
            throw new Error('incremental changes are not applicable');
        },
        getHeads(document) {
            return document.heads;
        },
    };
    const adapter = {
        roomId: 'room-1',
        participantId: 'participant-1',
        async runTool(name) {
            if (name === 'webmeet_scripta_sync_open') {
                openCalls += 1;
                return {
                    sessionId: 'session-1',
                    stateBase64: openCalls === 1 ? 'AQ==' : 'Ag==',
                    heads: [openCalls === 1 ? 'head-1' : 'head-2'],
                };
            }
            assert.equal(name, 'webmeet_scripta_sync_pull');
            return {
                changesBase64: ['Aw=='],
                heads: ['head-2'],
                resetRequired: false,
            };
        },
    };
    const replica = new ScriptaCrdtReplica(adapter, {
        loadAutomerge: async () => automerge,
        createActorId: () => 'actor-1',
    });

    await replica.open('resource-1');
    await replica.pull('resource-1');

    assert.equal((await replica.open('resource-1')).document.state, 'latest');
    assert.equal(openCalls, 2);
});
