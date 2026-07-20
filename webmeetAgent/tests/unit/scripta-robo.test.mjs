import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    applyRoomBlackboardChange,
    createMeeting,
    createScriptaDocument,
    createStoreContext,
    focusScripta,
    getRoomBlackboard,
    getScriptaContext,
    joinMeeting,
    listMeetingEvents,
    listRoomResources,
    listScriptaWorkspaceEntries,
    manageScriptaDocument,
    mutateScripta,
    navigateScripta,
    openScriptaDocument,
    openScriptaCollaboration,
    applyScriptaCollaboration,
} from '../../lib/webmeetStore.mjs';
import { executeRoboCommand } from '../../lib/scripta/command-service.mjs';
import { normalizeRoboIntent } from '../../lib/scripta/commands.mjs';
import { callScriptaExplorer } from '../../lib/scripta/explorer-crdt-client.mjs';
import { decryptRoomPayload, loadRoomRecord, mutateRoom } from '../../lib/store/roomRecords.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import { createMarkdownCrdtStore } from '../../../explorer/utils/server/markdown-crdt/markdown-crdt-store.mjs';
import { createScriptaCrdtService } from '../../../explorer/utils/server/markdown-crdt/scripta-crdt-service.mjs';
import {
    changeDocument,
    getDocumentChanges,
    loadDocument,
} from '../../../explorer/utils/server/markdown-crdt/automerge-adapter.mjs';
import {
    parseWebMeetEvent,
    WEBMEET_EVENT_TYPES,
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

const ADMIN = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
const USER = { user: { id: 'local:user', username: 'user', roles: ['user'] } };
const VICTIM = { user: { id: 'local:victim', username: 'victim', roles: ['user'] } };
const GUEST = { user: { id: 'guest:1', username: 'guest', roles: ['guest'] } };

function assertCanonicalJson(value) {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
        throw new TypeError('canonicalJson: undefined, function, and symbol values are not allowed');
    }
    if (Array.isArray(value)) {
        value.forEach(assertCanonicalJson);
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(assertCanonicalJson);
    }
}

async function withStore(fn) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-scripta-')));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.ploinky', 'webmeet');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'scripta-unit-test-key';
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });
    try {
        const context = await createStoreContext(root);
        const validatePath = async (input) => {
            const candidate = String(input || '');
            const target = path.isAbsolute(candidate) && candidate.startsWith(`${root}${path.sep}`)
                ? path.resolve(candidate)
                : path.resolve(root, candidate.replace(/^\/+/, ''));
            if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
                throw new Error('Path outside workspace.');
            }
            return target;
        };
        const crdtStore = createMarkdownCrdtStore({
            fs,
            path,
            workspaceRoot: root,
            validatePath,
            writeFileContent: (target, content) => fs.writeFile(target, content, 'utf8'),
            invalidateCachesForPath() {},
        });
        const explorer = createScriptaCrdtService({
            fs,
            path,
            workspaceRoot: root,
            validatePath,
            markdownCrdtStore: crdtStore,
        });
        const operations = {
            scripta_crdt_ensure_folder: explorer.ensureFolder,
            scripta_crdt_workspace_list: explorer.listWorkspace,
            scripta_crdt_create: explorer.create,
            scripta_crdt_open: explorer.open,
            scripta_crdt_mutate: explorer.mutate,
            scripta_crdt_delete: explorer.remove,
            scripta_collaboration_open: explorer.collaborationOpen,
            scripta_collaboration_pull: explorer.collaborationPull,
            scripta_collaboration_apply: explorer.collaborationApply,
        };
        context.scriptaExplorerClient = async (tool, args) => {
            assertCanonicalJson(args);
            return operations[tool](args);
        };
        return await fn(context, root);
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
}

test('WebMeet delegates SCRIPTA persistence to Explorer without a local state or filesystem fallback', async () => {
    const serviceSource = await fs.readFile(new URL('../../lib/scripta/service.mjs', import.meta.url), 'utf8');
    const clientSource = await fs.readFile(new URL('../../lib/scripta/explorer-crdt-client.mjs', import.meta.url), 'utf8');
    const mcpConfig = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const explorerMcpConfig = JSON.parse(await fs.readFile(new URL('../../../explorer/mcp-config.json', import.meta.url), 'utf8'));
    assert.doesNotMatch(serviceSource, /node:fs|node:path|readFile|writeFile/);
    assert.match(serviceSource, /scriptaExplorer/);
    assert.match(clientSource, /AgentMcpClient/);
    await assert.rejects(fs.stat(new URL('../../lib/scripta/scripta-state.js', import.meta.url)), /ENOENT/);
    const explorerOpenTool = explorerMcpConfig.tools.find((tool) => tool.name === 'scripta_crdt_open');
    const explorerMutateTool = explorerMcpConfig.tools.find((tool) => tool.name === 'scripta_crdt_mutate');
    assert.deepEqual(explorerOpenTool.inputSchema.view.properties.mode.enum, ['document', 'paragraph']);
    assert.equal(explorerMutateTool.inputSchema.args.properties.text.type, 'string');
    assert.equal(explorerMutateTool.inputSchema.args.properties.variantOrdinal.type, 'number');
    assert.equal(explorerMutateTool.inputSchema.participant.properties.hash.type, 'string');
    const workspaceListTool = mcpConfig.tools.find((tool) => tool.name === 'webmeet_scripta_workspace_list');
    assert.deepEqual(workspaceListTool.inputSchema, { roomId: { type: 'string', optional: false } });
    assert.equal('input' in workspaceListTool, false);
});

test('Explorer MCP envelopes are decoded and tool errors are not accepted as documents', async () => {
    const decoded = await callScriptaExplorer({
        scriptaExplorerClient: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, projection: { resourceId: 'resource-1' } }) }],
        }),
    }, 'scripta_crdt_open', { path: '/draft.md' });
    assert.equal(decoded.projection.resourceId, 'resource-1');

    await assert.rejects(callScriptaExplorer({
        scriptaExplorerClient: async () => ({
            isError: true,
            content: [{ type: 'text', text: 'MCP error -32603: ENOENT: no such file or directory' }],
        }),
    }, 'scripta_crdt_open', { path: '/missing.md' }), /ENOENT/);

    let transportedArgs = null;
    await callScriptaExplorer({
        scriptaExplorerClient: async (_tool, args) => {
            transportedArgs = args;
            return { ok: true };
        },
    }, 'scripta_crdt_mutate', {
        path: '/draft.md',
        operation: 'paragraph-move',
        args: { variantOrdinal: 2, targetIndex: 0 },
    });
    assert.deepEqual(transportedArgs.args, {
        variantOrdinal: 2,
        targetIndex: 0,
    });
});

test('missing SCRIPTA ordinals remain absent while target index zero remains valid', () => {
    const alternative = normalizeRoboIntent({
        kind: 'mutation',
        operation: 'p-variant-add',
        text: 'Alternative',
    });
    const chapter = normalizeRoboIntent({
        kind: 'mutation',
        operation: 'chapter-add',
    });
    const move = normalizeRoboIntent({
        kind: 'mutation',
        operation: 'paragraph-move',
        targetIndex: 0,
    });

    assert.equal(alternative.variantOrdinal, undefined);
    assert.equal(chapter.variantOrdinal, undefined);
    assert.equal(alternative.targetIndex, undefined);
    assert.equal(chapter.targetIndex, undefined);
    assert.equal(move.targetIndex, 0);
});

test('SCRIPTA command intents use only canonical p-variant operations', () => {
    assert.equal(normalizeRoboIntent({
        kind: 'mutation',
        operation: 'p-variant-delete',
        variantOrdinal: 2,
    }).operation, 'p-variant-delete');
    assert.throws(
        () => normalizeRoboIntent({ kind: 'mutation', operation: 'alternative-add' }),
        /unsupported mutation operation/
    );
});

test('SCRIPTA collaboration MCP accepts only the canonical p-variant edit operation', async () => {
    const config = JSON.parse(await fs.readFile(new URL('../../mcp-config.json', import.meta.url), 'utf8'));
    const tool = config.tools.find(({ name }) => name === 'webmeet_scripta_sync_apply');

    assert.deepEqual(tool?.inputSchema?.operation?.enum, ['p-variant-edit']);
});

test('room creation creates only its stable default SCRIPTA folder', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'Story Room', authInfo: ADMIN });
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.match(payload.scripta.folderPath, /^\/WebMeet\/story-room-/);
        const folder = path.join(root, payload.scripta.folderPath);
        assert.equal((await fs.stat(folder)).isDirectory(), true);
        assert.deepEqual(await fs.readdir(folder), []);
        assert.deepEqual(payload.scripta.documents, {});
    });
});

test('room creation rolls back the room record when its SCRIPTA folder cannot be created', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-room-rollback-'));
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    process.env.WEBMEET_DATA_DIR = path.join(root, '.webmeet-data');
    process.env.PLOINKY_WEBMEET_MASTER_KEY = 'unit-test-master-key';
    try {
        const context = await createStoreContext(root);
        context.scriptaExplorerClient = async (tool) => {
            assert.equal(tool, 'scripta_crdt_ensure_folder');
            throw new Error('Explorer unavailable');
        };

        await assert.rejects(
            createMeeting(context, { name: 'Must roll back', authInfo: ADMIN }),
            /Explorer unavailable/
        );
        assert.deepEqual(await fs.readdir(context.meetingsDir), []);
    } finally {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('a created SCRIPTA document survives a room attachment failure and reports a retryable result', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'Attachment failure', authInfo: ADMIN });
        const originalMeetingsDir = context.meetingsDir;
        const blockedPath = path.join(root, 'meetings-path-is-a-file');
        await fs.writeFile(blockedPath, 'not a directory');
        const baseExplorer = context.scriptaExplorerClient;
        context.scriptaExplorerClient = async (tool, args) => {
            const result = await baseExplorer(tool, args);
            if (tool === 'scripta_crdt_create') context.meetingsDir = blockedPath;
            return result;
        };

        let failure = null;
        try {
            await createScriptaDocument(context, {
                roomId: meeting.roomId,
                name: 'Created Once',
                template: 'general',
                participantId: 'admin',
                authInfo: ADMIN,
            });
        } catch (error) {
            failure = error;
        } finally {
            context.meetingsDir = originalMeetingsDir;
        }

        assert.equal(failure?.code, 'scripta_attachment_failed');
        assert.equal(failure?.documentCreated, true);
        assert.equal(failure?.attached, false);
        assert.equal(failure?.documentName, 'created-once.md');
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.equal(Object.keys(payload.scripta.documents || {}).length, 0);
        assert.equal((await fs.stat(path.join(
            root,
            payload.scripta.folderPath,
            'created-once.md'
        ))).isFile(), true);
    });
});

test('a missing attached SCRIPTA file is detached instead of persisting an empty widget', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'Missing document', authInfo: ADMIN });
        const created = await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Removed externally',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        const entry = payload.scripta.documents[created.resourceId];
        await fs.rm(path.join(root, entry.path.replace(/^\/+/, '')));
        await mutateRoom(context, meeting.roomId, (_record, current) => {
            current.scripta.documents[created.resourceId].projection = undefined;
        });

        const board = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        assert.equal(board.blackboard.widgets.some((widget) => widget.type === 'scripta-document'), false);
        assert.equal((await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'admin',
            authInfo: ADMIN,
        })).resources.length, 0);
    });
});

test('General creation produces one empty document and one singleton blackboard widget', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'General Room', authInfo: ADMIN });
        const created = await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Working Draft',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        assert.equal(created.ok, true);
        const current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(current.resources.length, 1);
        assert.equal(current.document.documentTitle, 'Working Draft');
        assert.equal(current.document.chapters.length, 1);
        assert.equal(current.document.chapters[0].chapterTitle, 'Chapter 1');
        assert.equal(current.document.chapters[0].paragraphs.length, 1);
        assert.equal(current.document.chapters[0].paragraphs[0].text, '');
        const board = await getRoomBlackboard(context, { roomId: meeting.roomId, boardId: 'agent:agent_robo_team', participantId: 'admin', authInfo: ADMIN });
        const scriptaWidgets = board.blackboard.widgets.filter((widget) => widget.type.startsWith('scripta-'));
        assert.equal(scriptaWidgets.length, 1);
        assert.equal(scriptaWidgets[0].id, 'robo_scripta_document');
        assert.equal(scriptaWidgets[0].type, 'scripta-document');
        assert.deepEqual(scriptaWidgets[0].properties.geometry, { x: 24, y: 24, width: 600, height: 400 });
        assert.equal(scriptaWidgets[0].properties.canBrowseWorkspace, true);
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.equal((await fs.stat(path.join(root, payload.scripta.folderPath, 'working-draft.md'))).isFile(), true);
    });
});

test('Vision and Plan are creation templates, not persistent document roles', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Templates', authInfo: ADMIN });
        const response = await executeRoboCommand(context, {
            roomId: meeting.roomId,
            text: '/robo create the vision document',
            participantId: 'admin',
            authInfo: ADMIN,
        }, { intent: {
            kind: 'document',
            operation: 'document-create',
            name: 'Film Vision',
            template: 'vision',
            objective: 'A noir film about stolen memories',
            visionParagraphs: [
                { text: 'A botanist investigates stolen memories.' },
                { text: 'Noir shadows meet botanical imagery.' },
                { text: 'An adult audience questions identity.' },
            ],
        } });
        assert.equal(response.ok, true);
        const current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(current.document.chapters[0].paragraphs.length, 3);
        const record = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        const entry = record.scripta.documents[current.activeResourceId];
        assert.equal('document' in entry, false);
        assert.equal(entry.documentId, current.document.documentId);
    });
});

test('semantic /event SCRIPTA command executes directly and finalizes its audit', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Semantic event', authInfo: ADMIN });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'general',
            participantId: 'participant-admin',
            authInfo: ADMIN,
        });

        const result = await dispatch('webmeet_event_command', {
            roomId: meeting.roomId,
            event: 'scripta-chapter-edit {"title":"Chapter 1 test zzzzzzz"}',
            source: 'event',
            commandSource: 'chat',
            participantId: 'participant-admin',
        }, context, ADMIN);

        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.auditMessage.metadata.status, 'success');
        const widget = result.blackboard.widgets.find((item) => item.type === 'scripta-document');
        assert.equal(widget.properties.chapters[0].chapterTitle, 'Chapter 1 test zzzzzzz');
        const current = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'participant-admin',
            authInfo: ADMIN,
        });
        assert.equal(current.document.chapters[0].chapterTitle, 'Chapter 1 test zzzzzzz');
    });
});

test('document and paragraph modes navigate across chapter boundaries', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Navigation', authInfo: ADMIN });
        await createScriptaDocument(context, { roomId: meeting.roomId, name: 'Plan', template: 'plan', initialization: {
            title: 'The real document title',
            chapters: [
                { title: 'Opening', paragraphs: [{ text: 'First.' }] },
                { title: 'Investigation', paragraphs: [{ text: 'Second.' }] },
            ],
        }, participantId: 'admin', authInfo: ADMIN });
        let current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        const first = current.documentOutline[0].paragraphs[0];
        const baseExplorer = context.scriptaExplorerClient;
        let focusOpenCalls = 0;
        context.scriptaExplorerClient = async (tool, args) => {
            if (tool === 'scripta_crdt_open') focusOpenCalls += 1;
            return baseExplorer(tool, args);
        };
        const focused = await focusScripta(context, { roomId: meeting.roomId, chapterId: current.documentOutline[0].chapterId, paragraphId: first.paragraphId, mode: 'paragraph', participantId: 'admin', authInfo: ADMIN });
        assert.equal(focusOpenCalls, 0);
        const focusedWidget = focused.blackboard.widgets.find((widget) => widget.type === 'scripta-document');
        assert.equal(focusedWidget.properties.viewMode, 'paragraph');
        assert.equal(focusedWidget.properties.focusedParagraphId, first.paragraphId);
        await navigateScripta(context, { roomId: meeting.roomId, direction: 'next', participantId: 'admin', authInfo: ADMIN });
        assert.equal(focusOpenCalls, 1);
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(current.view.mode, 'paragraph');
        assert.equal(current.paragraph.chapterTitle, 'Investigation');
        assert.equal('paragraphTitle' in current.paragraph, false);
        assert.equal('paragraphTitle' in current.documentOutline[1].paragraphs[0], false);
        const opensBeforeDocumentView = focusOpenCalls;
        await focusScripta(context, { roomId: meeting.roomId, mode: 'document', participantId: 'admin', authInfo: ADMIN });
        assert.equal(focusOpenCalls, opensBeforeDocumentView);
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(current.view.mode, 'document');
        assert.equal(current.view.paragraphId, current.documentOutline[1].paragraphs[0].paragraphId);
    });
});

test('browser collaboration uses a public CRDT replica through WebMeet without workspace paths', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Collaboration', authInfo: ADMIN });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'admin', authInfo: ADMIN });
        const chapter = current.documentOutline[0];
        const paragraph = chapter.paragraphs[0];
        const opened = await openScriptaCollaboration(context, {
            roomId: meeting.roomId,
            resourceId: current.activeResourceId,
            participantId: 'admin',
            clientId: 'browser-a',
            authInfo: ADMIN,
        });
        assert.equal('path' in opened, false);
        assert.equal(opened.projection.paragraph.variants[0].canEdit, true);
        assert.equal('_ownerHash' in opened.projection.paragraph.variants[0], false);
        const browserDocument = loadDocument(
            Buffer.from(opened.stateBase64, 'base64'),
            { actor: crypto.randomBytes(16).toString('hex') },
        );
        const activeVariantId = browserDocument.chapters[0].paragraphs[0].pluginState.scripta.activeVariantId;
        const browserState = browserDocument.chapters[0].paragraphs[0].pluginState.scripta;
        assert.equal(Object.hasOwn(browserState.variants[0], 'createdBy'), false);
        assert.deepEqual(browserState.reactionsByVariant, {});
        const edited = changeDocument(browserDocument, (draft) => {
            draft.chapters[0].paragraphs[0].pluginState.scripta.variants
                .find((variant) => variant.id === activeVariantId).text = 'Collaborative text';
        });
        const applied = await applyScriptaCollaboration(context, {
            roomId: meeting.roomId,
            resourceId: current.activeResourceId,
            participantId: 'admin',
            clientId: 'browser-a',
            sessionId: opened.sessionId,
            operation: 'p-variant-edit',
            args: {
                chapterId: chapter.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: activeVariantId,
                text: 'Collaborative text',
            },
            changesBase64: getDocumentChanges(browserDocument, edited)
                .map((change) => Buffer.from(change).toString('base64')),
            baseHeads: opened.heads,
            authInfo: ADMIN,
        });
        assert.equal(applied.projection.paragraph.currentText, 'Collaborative text');
        assert.equal(applied.blackboard.widgets.find((widget) => widget.type === 'scripta-document')
            .properties.paragraph.currentText, 'Collaborative text');
        assert.equal('path' in applied, false);
    });
});

test('SCRIPTA persistent events carry document and room participant identities with correct semantics', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'SCRIPTA events', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'User',
            participantId: 'user',
            authInfo: USER,
        });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Events',
            template: 'general',
            participantId: 'user',
            authInfo: USER,
        });

        const afterCreate = (await listMeetingEvents(context, meeting.roomId)).map(parseWebMeetEvent);
        const createdEvent = afterCreate.find(
            (event) => event.type === WEBMEET_EVENT_TYPES.SCRIPTA_DOCUMENT_CHANGED,
        );
        assert.ok(createdEvent?.payload.documentId);
        assert.equal(createdEvent.payload.participantId, 'user');
        const lastCreateEventId = afterCreate.at(-1).id;

        const current = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'user',
            authInfo: USER,
        });
        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: current.documentOutline[0].chapterId,
            paragraphId: current.documentOutline[0].paragraphs[0].paragraphId,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });
        const focusEvents = (await listMeetingEvents(context, meeting.roomId, {
            afterId: lastCreateEventId,
        })).map(parseWebMeetEvent);
        assert.ok(focusEvents.some(
            (event) => event.type === WEBMEET_EVENT_TYPES.SCRIPTA_CONTEXT_CHANGED,
        ));
        assert.equal(focusEvents.some(
            (event) => event.type === WEBMEET_EVENT_TYPES.SCRIPTA_DOCUMENT_CHANGED,
        ), false);

        const lastFocusEventId = focusEvents.at(-1).id;
        await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-vote',
            variantId: current.paragraph.variants[0].id,
            type: 'like',
            participantId: 'user',
            authInfo: USER,
        });
        const voteEvents = (await listMeetingEvents(context, meeting.roomId, {
            afterId: lastFocusEventId,
        })).map(parseWebMeetEvent);
        const voteEvent = voteEvents.find(
            (event) => event.type === WEBMEET_EVENT_TYPES.SCRIPTA_VOTE_CHANGED,
        );
        assert.ok(voteEvent?.payload.documentId);
        assert.equal(voteEvent.payload.participantId, 'user');
        assert.ok(voteEvents.some(
            (event) => event.type === WEBMEET_EVENT_TYPES.SCRIPTA_DOCUMENT_CHANGED,
        ));
    });
});

test('adding chapters and paragraphs focuses the newly created document element', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Creation focus', authInfo: ADMIN });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });

        const chapterAdded = await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'chapter-add',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        let widget = chapterAdded.blackboard.widgets.find((entry) => entry.id === 'robo_scripta_document');
        assert.equal(chapterAdded.focus.mode, 'document');
        assert.equal(chapterAdded.focus.focusTargetType, 'chapter');
        assert.equal(chapterAdded.focus.chapterId, widget.properties.chapters.at(-1).chapterId);
        assert.equal(widget.properties.focusedChapterId, chapterAdded.focus.chapterId);
        assert.equal(widget.properties.autoFocusRevision, widget.properties.documentRevision);

        const paragraphAdded = await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'paragraph-add',
            chapterId: chapterAdded.focus.chapterId,
            participantId: 'admin',
            authInfo: ADMIN,
        });
        widget = paragraphAdded.blackboard.widgets.find((entry) => entry.id === 'robo_scripta_document');
        const focusedChapter = widget.properties.chapters.find((entry) => entry.chapterId === paragraphAdded.focus.chapterId);
        assert.equal(paragraphAdded.focus.mode, 'document');
        assert.equal(paragraphAdded.focus.focusTargetType, 'paragraph');
        assert.equal(paragraphAdded.focus.paragraphId, focusedChapter.paragraphs.at(-1).paragraphId);
        assert.equal(widget.properties.focusedParagraphId, paragraphAdded.focus.paragraphId);
        assert.equal(widget.properties.autoFocusRevision, widget.properties.documentRevision);
    });
});

test('widget and chat mutations share variants, votes, and active text', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Votes', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'User',
            participantId: 'user',
            authInfo: USER,
        });
        await createScriptaDocument(context, { roomId: meeting.roomId, name: 'Draft', template: 'general', participantId: 'user', authInfo: USER });
        let current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        await mutateScripta(context, { roomId: meeting.roomId, operation: 'p-variant-add', text: 'A stronger version', participantId: 'user', authInfo: USER });
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        const variant = current.paragraph.variants[1];
        await mutateScripta(context, { roomId: meeting.roomId, operation: 'p-variant-vote', variantId: variant.id, type: 'like', participantId: 'user', authInfo: USER });
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        assert.equal(current.paragraph.activeVariantId, variant.id);
        assert.equal(current.paragraph.currentText, 'A stronger version');
        assert.deepEqual(current.paragraph.viewerVote, { variantId: variant.id, type: 'like' });
    });
});

test('paragraph variant ownership controls edit and delete but not voting', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Variant ownership', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'Owner',
            participantId: 'user',
            authInfo: USER,
        });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'Other',
            participantId: 'victim',
            authInfo: VICTIM,
        });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Owned variants',
            template: 'general',
            participantId: 'user',
            authInfo: USER,
        });
        await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-add',
            text: 'Owned alternative',
            participantId: 'user',
            authInfo: USER,
        });
        const ownerContext = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'user',
            authInfo: USER,
        });
        const variant = ownerContext.paragraph.variants[1];
        assert.equal(variant.canEdit, true);
        assert.equal(variant.canDelete, true);
        assert.equal('_ownerHash' in variant, false);

        const otherContext = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'victim',
            authInfo: VICTIM,
        });
        const otherVariant = otherContext.paragraph.variants.find((entry) => entry.id === variant.id);
        assert.equal(otherVariant.canEdit, false);
        assert.equal(otherVariant.canDelete, false);

        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: ownerContext.paragraph.chapterId,
            paragraphId: ownerContext.paragraph.paragraphId,
            variantId: variant.id,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });
        const sharedSelection = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'victim',
            authInfo: VICTIM,
        });
        assert.equal(sharedSelection.view.selectedVariantId, variant.id);
        assert.equal(sharedSelection.paragraph.selectedVariantId, variant.id);

        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: ownerContext.paragraph.chapterId,
            paragraphId: ownerContext.paragraph.paragraphId,
            variantId: variant.id,
            editing: true,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });
        const sharedEditor = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'victim',
            authInfo: VICTIM,
        });
        assert.equal(sharedEditor.paragraph.editingVariantId, variant.id);
        assert.equal(sharedEditor.paragraph.editorParticipantId, 'user');
        await assert.rejects(
            focusScripta(context, {
                roomId: meeting.roomId,
                chapterId: ownerContext.paragraph.chapterId,
                paragraphId: ownerContext.paragraph.paragraphId,
                variantId: variant.id,
                editing: true,
                mode: 'paragraph',
                participantId: 'victim',
                authInfo: VICTIM,
            }),
            (error) => error?.code === 'scripta_variant_forbidden'
        );
        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: ownerContext.paragraph.chapterId,
            paragraphId: ownerContext.paragraph.paragraphId,
            variantId: variant.id,
            editing: false,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });

        await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-vote',
            variantId: variant.id,
            type: 'like',
            participantId: 'victim',
            authInfo: VICTIM,
        });
        await assert.rejects(
            mutateScripta(context, {
                roomId: meeting.roomId,
                operation: 'p-variant-edit',
                variantId: variant.id,
                text: 'Changed by another participant',
                participantId: 'victim',
                authInfo: VICTIM,
            }),
            (error) => error?.code === 'scripta_variant_forbidden'
        );
        await assert.rejects(
            mutateScripta(context, {
                roomId: meeting.roomId,
                operation: 'p-variant-delete',
                variantId: variant.id,
                participantId: 'victim',
                authInfo: VICTIM,
            }),
            (error) => error?.code === 'scripta_variant_forbidden'
        );

        const ownerBoardBeforeDelete = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'user',
            authInfo: USER,
        });
        const otherBoardBeforeDelete = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'victim',
            authInfo: VICTIM,
        });
        const ownerBoardVariant = ownerBoardBeforeDelete.blackboard.widgets
            .find((entry) => entry.id === 'robo_scripta_document')
            .properties.paragraph.variants.find((entry) => entry.id === variant.id);
        const otherBoardVariant = otherBoardBeforeDelete.blackboard.widgets
            .find((entry) => entry.id === 'robo_scripta_document')
            .properties.paragraph.variants.find((entry) => entry.id === variant.id);
        assert.equal(ownerBoardVariant.canEdit, true);
        assert.equal(ownerBoardVariant.canDelete, true);
        assert.equal(otherBoardVariant.canEdit, false);
        assert.equal(otherBoardVariant.canDelete, false);

        await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-delete',
            variantId: variant.id,
            participantId: 'user',
            authInfo: USER,
        });
        const afterDelete = await getScriptaContext(context, {
            roomId: meeting.roomId,
            participantId: 'user',
            authInfo: USER,
        });
        assert.equal(afterDelete.paragraph.variants.some((entry) => entry.id === variant.id), false);

        const ownerBoard = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'user',
            authInfo: USER,
        });
        const publicVariants = ownerBoard.blackboard.widgets
            .find((entry) => entry.id === 'robo_scripta_document')
            .properties.paragraph.variants;
        assert.equal(publicVariants.every((entry) => !('_ownerHash' in entry)), true);
    });
});

test('SCRIPTA content projections preserve user-resized widget geometry', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Resize persistence', authInfo: ADMIN });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const initialBoard = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const resizedGeometry = { x: 72, y: 56, width: 840, height: 560 };
        await applyRoomBlackboardChange(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'admin',
            authInfo: ADMIN,
            expectedBoardVersion: initialBoard.blackboard.version,
            change: {
                changeType: 'update',
                targetType: 'widget',
                targetRef: 'robo_scripta_document',
                reason: 'resize',
                patch: { properties: { geometry: resizedGeometry } },
            },
        });

        await mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-add',
            text: 'A new variant after resize',
            participantId: 'admin',
            authInfo: ADMIN,
        });

        const projectedBoard = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const widget = projectedBoard.blackboard.widgets.find((entry) => entry.id === 'robo_scripta_document');
        assert.deepEqual(widget.properties.geometry, resizedGeometry);
    });
});

test('an untargeted paragraph mutation uses the focused paragraph instead of the first paragraph', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Focused mutation', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'User',
            participantId: 'user',
            authInfo: USER,
        });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'plan',
            initialization: {
                chapters: [{
                    title: 'Chapter',
                    paragraphs: [
                        { title: 'First', text: 'First text' },
                        { title: 'Second', text: 'Second text' },
                    ],
                }],
            },
            participantId: 'user',
            authInfo: USER,
        });
        let current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        const chapter = current.documentOutline[0];
        const second = chapter.paragraphs[1];
        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: chapter.chapterId,
            paragraphId: second.paragraphId,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });
        await executeRoboCommand(context, {
            roomId: meeting.roomId,
            text: '/robo add an alternative',
            participantId: 'user',
            authInfo: USER,
        }, { intent: { kind: 'mutation', operation: 'p-variant-add', text: 'Second alternative' } });
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        assert.equal(current.paragraph.paragraphId, second.paragraphId);
        assert.ok(current.paragraph.variants.some((variant) => variant.text === 'Second alternative'));
        await focusScripta(context, {
            roomId: meeting.roomId,
            chapterId: chapter.chapterId,
            paragraphId: chapter.paragraphs[0].paragraphId,
            mode: 'paragraph',
            participantId: 'user',
            authInfo: USER,
        });
        current = await getScriptaContext(context, { roomId: meeting.roomId, participantId: 'user', authInfo: USER });
        assert.equal(current.paragraph.variants.some((variant) => variant.text === 'Second alternative'), false);
    });
});

test('SCRIPTA rejects a participant id owned by another authenticated user', async () => {
    await withStore(async (context) => {
        const meeting = await createMeeting(context, { name: 'Identity', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'User',
            participantId: 'participant-user',
            authInfo: USER,
        });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'Victim',
            participantId: 'participant-victim',
            authInfo: VICTIM,
        });
        await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Draft',
            template: 'general',
            participantId: 'participant-user',
            authInfo: USER,
        });
        await assert.rejects(mutateScripta(context, {
            roomId: meeting.roomId,
            operation: 'p-variant-add',
            text: 'Spoofed alternative',
            participantId: 'participant-victim',
            authInfo: USER,
        }), /cannot act as another participant/);
    });
});

test('opening Markdown converts it idempotently and prevents cross-room attachment', async () => {
    await withStore(async (context, root) => {
        await fs.mkdir(path.join(root, 'stories'), { recursive: true });
        await fs.writeFile(path.join(root, 'stories', 'existing.md'), '# Existing title\n\n## Real chapter\n\nFirst paragraph.\n\nSecond paragraph.\n');
        const firstRoom = await createMeeting(context, { name: 'First', authInfo: ADMIN });
        const secondRoom = await createMeeting(context, { name: 'Second', authInfo: ADMIN });
        await openScriptaDocument(context, { roomId: firstRoom.roomId, path: '/stories/existing.md', participantId: 'admin', authInfo: ADMIN });
        const first = await getScriptaContext(context, { roomId: firstRoom.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(first.document.documentTitle, 'Existing title');
        assert.equal(first.document.chapters[0].chapterTitle, 'Real chapter');
        assert.equal(first.document.chapters[0].paragraphs.length, 2);
        await assert.rejects(
            openScriptaDocument(context, { roomId: secondRoom.roomId, path: '/stories/existing.md', participantId: 'admin', authInfo: ADMIN }),
            /already attached/,
        );
        await createScriptaDocument(context, {
            roomId: firstRoom.roomId,
            name: 'Replacement',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const firstAfterReplacement = await getScriptaContext(context, { roomId: firstRoom.roomId, participantId: 'admin', authInfo: ADMIN });
        assert.equal(firstAfterReplacement.resources.length, 1);
        assert.equal(firstAfterReplacement.document.documentTitle, 'Replacement');
        const released = await openScriptaDocument(context, {
            roomId: secondRoom.roomId,
            path: '/stories/existing.md',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        assert.equal(released.ok, true);
    });
});

test('document attachment locks do not serialize unrelated rooms and paths', async () => {
    await withStore(async (context, root) => {
        await fs.mkdir(path.join(root, 'stories'), { recursive: true });
        await Promise.all([
            fs.writeFile(path.join(root, 'stories', 'first.md'), '# First\n\n## Chapter\n\nParagraph.\n'),
            fs.writeFile(path.join(root, 'stories', 'second.md'), '# Second\n\n## Chapter\n\nParagraph.\n'),
        ]);
        const firstRoom = await createMeeting(context, { name: 'First lock room', authInfo: ADMIN });
        const secondRoom = await createMeeting(context, { name: 'Second lock room', authInfo: ADMIN });
        const baseExplorer = context.scriptaExplorerClient;
        let openCalls = 0;
        let releaseOpens;
        let bothStarted;
        const openGate = new Promise((resolve) => { releaseOpens = resolve; });
        const started = new Promise((resolve) => { bothStarted = resolve; });
        context.scriptaExplorerClient = async (tool, args) => {
            if (tool === 'scripta_crdt_open') {
                openCalls += 1;
                if (openCalls === 2) bothStarted();
                await openGate;
            }
            return baseExplorer(tool, args);
        };

        const firstOpen = openScriptaDocument(context, {
            roomId: firstRoom.roomId,
            path: '/stories/first.md',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const secondOpen = openScriptaDocument(context, {
            roomId: secondRoom.roomId,
            path: '/stories/second.md',
            participantId: 'admin',
            authInfo: ADMIN,
        });

        try {
            await Promise.race([
                started,
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error('Unrelated SCRIPTA document opens were serialized.')),
                    1_000
                )),
            ]);
        } finally {
            releaseOpens();
        }
        assert.equal(openCalls, 2);
        await Promise.all([firstOpen, secondOpen]);
    });
});

test('failed deletion commit restores both the CRDT document and room attachment', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'Delete rollback', authInfo: ADMIN });
        const created = await createScriptaDocument(context, {
            roomId: meeting.roomId,
            name: 'Rollback Draft',
            template: 'general',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        const baseExplorer = context.scriptaExplorerClient;
        let failCommit = true;
        context.scriptaExplorerClient = async (tool, args) => {
            if (tool === 'scripta_crdt_delete' && args.phase === 'commit' && failCommit) {
                failCommit = false;
                throw new Error('Injected deletion commit failure.');
            }
            return baseExplorer(tool, args);
        };

        await assert.rejects(manageScriptaDocument(context, {
            roomId: meeting.roomId,
            operation: 'document-delete',
            resourceId: created.resourceId,
            confirmed: true,
            participantId: 'admin',
            authInfo: ADMIN,
        }), /Injected deletion commit failure/);

        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.ok(payload.scripta.documents[created.resourceId]);
        assert.equal((await fs.stat(path.join(root, payload.scripta.folderPath, 'rollback-draft.md'))).isFile(), true);
        const board = await getRoomBlackboard(context, {
            roomId: meeting.roomId,
            boardId: 'agent:agent_robo_team',
            participantId: 'admin',
            authInfo: ADMIN,
        });
        assert.equal(board.blackboard.widgets.some((widget) => widget.type === 'scripta-document'), true);
    });
});

test('workspace picker skips runtime data and folder limits do not hide Markdown documents', async () => {
    await withStore(async (context, root) => {
        await fs.mkdir(path.join(root, '.data'), { recursive: true });
        await fs.writeFile(path.join(root, '.data', 'internal.md'), '# Internal runtime data\n');
        await Promise.all(Array.from({ length: 510 }, (_, index) => (
            fs.mkdir(path.join(root, 'generated-folders', `folder-${String(index).padStart(3, '0')}`), { recursive: true })
        )));
        await fs.mkdir(path.join(root, 'z-user-notes'), { recursive: true });
        await fs.writeFile(path.join(root, 'z-user-notes', 'visible.MD'), '# Visible document\n');
        const meeting = await createMeeting(context, { name: 'Picker', authInfo: ADMIN });

        const picker = await listScriptaWorkspaceEntries(context, { roomId: meeting.roomId, authInfo: ADMIN });

        assert.equal(picker.folders.length, 500);
        assert.equal(picker.folders.some((folder) => folder.startsWith('/.data')), false);
        assert.equal(picker.documents.some((documentPath) => documentPath === '/.data/internal.md'), false);
        assert.equal(picker.documents.includes('/z-user-notes/visible.MD'), true);
    });
});

test('guest projections omit workspace paths and physical deletion requires confirmation', async () => {
    await withStore(async (context, root) => {
        const meeting = await createMeeting(context, { name: 'Guest Room', roomType: 'guest', authInfo: ADMIN });
        await joinMeeting(context, {
            meetingId: meeting.roomId,
            displayName: 'Guest',
            participantId: 'guest',
            authInfo: GUEST,
        });
        const created = await createScriptaDocument(context, { roomId: meeting.roomId, name: 'Guest Draft', template: 'general', folderPath: '/private-choice', participantId: 'guest', authInfo: GUEST });
        const resources = await listRoomResources(context, meeting.roomId, GUEST);
        assert.ok(resources.resources.every((resource) => resource.path === undefined));
        const board = await getRoomBlackboard(context, { roomId: meeting.roomId, boardId: 'agent:agent_robo_team', participantId: 'guest', authInfo: GUEST });
        assert.equal(JSON.stringify(board.blackboard).includes('/WebMeet/'), false);
        assert.equal(board.blackboard.widgets.find((widget) => widget.type === 'scripta-document').properties.canBrowseWorkspace, false);
        await assert.rejects(listScriptaWorkspaceEntries(context, { roomId: meeting.roomId, authInfo: GUEST }), /cannot browse/);
        const picker = await listScriptaWorkspaceEntries(context, { roomId: meeting.roomId, authInfo: ADMIN });
        const beforeDeletePayload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.equal(picker.defaultFolder, beforeDeletePayload.scripta.folderPath);
        assert.ok(picker.defaultDocuments.some((documentPath) => documentPath.endsWith('/guest-draft.md')));
        assert.ok(picker.documents.some((documentPath) => documentPath.endsWith('/guest-draft.md')));
        const reopened = await executeRoboCommand(context, {
            roomId: meeting.roomId,
            text: '/robo open Guest Draft',
            participantId: 'guest',
            authInfo: GUEST,
        }, {
            intent: { kind: 'document', operation: 'document-open', path: 'Guest Draft' },
        });
        assert.equal(reopened.ok, true);
        await assert.rejects(openScriptaDocument(context, {
            roomId: meeting.roomId,
            path: '/private-choice/secret.md',
            participantId: 'guest',
            authInfo: GUEST,
        }), /not found in this room/);
        await assert.rejects(manageScriptaDocument(context, { roomId: meeting.roomId, operation: 'document-delete', resourceId: created.resourceId, participantId: 'guest', authInfo: GUEST }), /confirmation/);
        const deleted = await manageScriptaDocument(context, { roomId: meeting.roomId, operation: 'document-delete', resourceId: created.resourceId, confirmed: true, participantId: 'guest', authInfo: GUEST });
        assert.equal(deleted.blackboard.widgets.some((widget) => widget.type === 'scripta-document'), false);
        const boardAfterDelete = await getRoomBlackboard(context, { roomId: meeting.roomId, boardId: 'agent:agent_robo_team', participantId: 'guest', authInfo: GUEST });
        assert.equal(boardAfterDelete.blackboard.widgets.some((widget) => widget.type === 'scripta-document'), false);
        const payload = decryptRoomPayload(context, await loadRoomRecord(context, meeting.roomId));
        assert.equal(Object.keys(payload.scripta.documents).length, 0);
        await assert.rejects(fs.stat(path.join(root, payload.scripta.folderPath, 'guest-draft.md')), /ENOENT/);
    });
});
