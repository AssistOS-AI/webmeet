import test from 'node:test';
import assert from 'node:assert/strict';

import { directUserAuth, delegatedUserAuth } from './verified-grant-fixture.mjs';
import { deriveAuthChatAuthor } from '../../tools/webmeet_tool.mjs';
import { getAuthDisplayName, isAdminAuthInfo } from '../../lib/store/accessPolicy.mjs';

test('verified direct grant: chat author is the actor displayName, not the raw id', async () => {
    const authInfo = await directUserAuth({ id: 'USER.3', displayName: 'adiganga2002' });
    assert.equal(authInfo.user.username, 'USER.3');
    const author = deriveAuthChatAuthor(authInfo);
    assert.equal(author.authorName, 'adiganga2002');
    assert.equal(author.authorId, 'USER.3');
    assert.equal(getAuthDisplayName(authInfo), 'adiganga2002');
});

test('verified direct grant without displayName, name or email: Participant, never the raw id', async () => {
    const authInfo = await directUserAuth({ id: 'USER.3' });
    const author = deriveAuthChatAuthor(authInfo);
    assert.equal(author.authorName, 'Participant');
    assert.notEqual(author.authorName, 'USER.3');
    assert.equal(author.authorId, 'USER.3');
    assert.equal(getAuthDisplayName(authInfo), '');
});

test('delegated user grant: usr.displayName wins, then a real username', async () => {
    const agentId = 'agent:webmeet/webmeetScribeAgent';
    const named = await delegatedUserAuth({ agentId, user: { id: 'USER.4', username: 'USER.4', displayName: 'mircea', email: 'm@x.com', roles: ['user'] } });
    assert.equal(deriveAuthChatAuthor(named).authorName, 'mircea');
    const emailOnly = await delegatedUserAuth({ agentId, user: { id: 'USER.4', username: 'USER.4', email: 'm@x.com', roles: ['user'] } });
    assert.equal(deriveAuthChatAuthor(emailOnly).authorName, 'm@x.com');
});

test('agent caller without a user: the agent name', () => {
    const authInfo = { principalId: 'agent:webmeet/webmeetScribeAgent', agent: { principalId: 'agent:webmeet/webmeetScribeAgent', name: 'webmeet/webmeetScribeAgent' } };
    assert.equal(deriveAuthChatAuthor(authInfo).authorName, 'webmeet/webmeetScribeAgent');
});

test('A6b: actor displayName "admin" with roles [user] grants no administration', async () => {
    const authInfo = await directUserAuth({ id: 'USER.9', roles: ['user'], displayName: 'admin' });
    assert.equal(deriveAuthChatAuthor(authInfo).authorName, 'admin');
    assert.equal(isAdminAuthInfo(authInfo), false);
});

// Store-level checks: archive record, attachment author and join fallback.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMeeting, createStoreContext, joinMeeting, archiveMeeting, publishRoomAttachment, getRoomBlackboard } from '../../lib/webmeetStore.mjs';
import { dispatch } from '../../tools/webmeet_tool.mjs';
import { installEdgeJoinFixture } from './edge-join-fixture.mjs';
import { PRINCIPALS } from './verified-grant-fixture.mjs';

async function storeFixture(t) {
    const previousDataDir = process.env.WEBMEET_DATA_DIR;
    const previousMasterKey = process.env.PLOINKY_WEBMEET_MASTER_KEY;
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-author-name-'));
    process.env.WEBMEET_DATA_DIR = root;
    process.env.PLOINKY_WEBMEET_MASTER_KEY = '0123456789abcdef0123456789abcdef';
    t.after(async () => {
        if (previousDataDir === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousDataDir;
        if (previousMasterKey === undefined) delete process.env.PLOINKY_WEBMEET_MASTER_KEY;
        else process.env.PLOINKY_WEBMEET_MASTER_KEY = previousMasterKey;
        await fs.rm(root, { recursive: true, force: true });
    });
    const context = installEdgeJoinFixture(await createStoreContext(root));
    context.scriptaExplorerClient = async (tool, args) => {
        if (tool === 'scripta_crdt_ensure_folder') return { ok: true, folderPath: args.folderPath };
        if (tool === 'webmeet_media_commit') {
            return { ok: true, asset: {
                assetId: 'asset_a1', kind: 'file', filename: 'a.pdf', mimeType: 'application/pdf',
                extension: 'pdf', size: 10, workspaceUrl: `${args.roomFolderPath}/assets/asset_a1/a.pdf`
            } };
        }
        throw new Error(`Unexpected Explorer tool ${tool}`);
    };
    return context;
}

const BLOB = { id: 'b'.repeat(48), agent: 'explorer', localPath: `blobs/${'b'.repeat(48)}` };

test('delegated user whose username differs from the id: username beats email', async () => {
    const authInfo = await delegatedUserAuth({
        agentId: 'agent:webmeet/webmeetScribeAgent',
        user: { id: 'USER.4', username: 'mircea', email: 'm@x.com', roles: ['user'] }
    });
    assert.equal(deriveAuthChatAuthor(authInfo).authorName, 'mircea');
});

test('archive event stores the verified name, and an empty name when none exists', async (t) => {
    const context = await storeFixture(t);
    const named = await createMeeting(context, { title: 'Named archive', roomType: 'team', authInfo: { user: { id: 'local:admin', username: 'admin', displayName: 'Boss', roles: ['admin'] } } });
    const result = await archiveMeeting(context, named.id, { user: { id: 'local:admin', username: 'admin', displayName: 'Boss', roles: ['admin'] } });
    assert.equal(result.archiveEvent.archivedByName, 'Boss');
    const anon = await createMeeting(context, { title: 'Unnamed archive', roomType: 'team', authInfo: { user: { id: 'USER.7', roles: ['admin'] } } });
    const result2 = await archiveMeeting(context, anon.id, { user: { id: 'USER.7', username: 'USER.7', roles: ['admin'] } });
    assert.equal(result2.archiveEvent.archivedByName, '');
    assert.equal(result2.archiveEvent.archivedById, 'USER.7');
});

test('joinRoom without a browser displayName uses the verified name, else Participant, never USER.N', async (t) => {
    const context = await storeFixture(t);
    const admin = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
    const room = await createMeeting(context, { title: 'Join fallback', roomType: 'team', authInfo: admin });
    const named = await joinMeeting(context, { meetingId: room.id, participantId: 'p-named', authInfo: { user: { id: 'USER.3', username: 'USER.3', displayName: 'adiganga2002', roles: ['user'] } } });
    assert.equal(named.participant.displayName, 'adiganga2002');
    const anon = await joinMeeting(context, { meetingId: room.id, participantId: 'p-anon', authInfo: { user: { id: 'USER.5', username: 'USER.5', roles: ['user'] } } });
    assert.equal(anon.participant.displayName, 'Participant');
});

test('attachment author: verified name for a user, member name for a guest caller', async (t) => {
    const context = await storeFixture(t);
    const admin = { user: { id: 'local:admin', username: 'admin', roles: ['admin'] } };
    const room = await createMeeting(context, { title: 'Attachments', roomType: 'team', authInfo: admin });
    const userAuth = { user: { id: 'USER.3', username: 'USER.3', displayName: 'adiganga2002', roles: ['user'] } };
    await joinMeeting(context, { meetingId: room.id, participantId: 'p-user', displayName: 'Stale USER.3', authInfo: userAuth });
    const board = (await getRoomBlackboard(context, { roomId: room.id, participantId: 'admin', authInfo: admin })).workspace.activeBoardId;
    const published = await publishRoomAttachment(context, { roomId: room.id, boardId: board, participantId: 'p-user', blobRef: BLOB, authInfo: userAuth });
    assert.equal(published.message.authorName, 'adiganga2002');

    const nameless = { user: { id: 'USER.6', username: 'USER.6', roles: ['user'] } };
    await joinMeeting(context, { meetingId: room.id, participantId: 'p-nameless', displayName: 'Stale USER.6', authInfo: nameless });
    const second = await publishRoomAttachment(context, { roomId: room.id, boardId: board, participantId: 'p-nameless', blobRef: BLOB, authInfo: nameless });
    assert.equal(second.message.authorName, 'Participant');

    const guestRoom = await createMeeting(context, { title: 'Guest attachments', roomType: 'guest', authInfo: admin });
    const guestAuth = {
        principalId: 'user:guest:g1',
        invocation: {
            issuer: 'ploinky-router',
            subject: 'user:guest:g1',
            actor: { kind: 'guest', id: 'user:guest:g1', roles: ['guest'] },
            caller: { kind: 'user', id: 'user:guest:g1', roles: ['guest'] },
            scope: [`public:webmeet:room:${guestRoom.id}`],
            tool: 'webmeet_room_join_guest'
        }
    };
    await dispatch('webmeet_room_join_guest', { roomId: guestRoom.id, displayName: 'Guest Gail', participantId: 'p-guest' }, context, guestAuth);
    const guestBoard = (await getRoomBlackboard(context, { roomId: guestRoom.id, participantId: 'admin', authInfo: admin })).workspace.activeBoardId;
    const guestPublished = await publishRoomAttachment(context, { roomId: guestRoom.id, boardId: guestBoard, participantId: 'p-guest', blobRef: BLOB, authInfo: guestAuth });
    assert.equal(guestPublished.message.authorName, 'Guest Gail');
});
