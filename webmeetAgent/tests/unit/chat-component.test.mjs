import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatComponent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/chat-component.js';
import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

function createListenerTarget() {
    const listeners = new Map();
    const classes = new Set();
    return {
        listeners,
        classList: {
            toggle(name, active) {
                if (active) classes.add(name);
                else classes.delete(name);
            },
            contains: (name) => classes.has(name),
        },
        addEventListener(name, handler) {
            listeners.set(name, handler);
        },
        removeEventListener(name, handler) {
            if (listeners.get(name) === handler) listeners.delete(name);
        },
        dispatch(name, event = {}) {
            listeners.get(name)?.(event);
        },
    };
}

function makeComponent(overrides = {}) {
    const state = { chat: [], session: { participantIdentity: 'p-1', participant: { displayName: 'User One' } } };
    const calls = [];
    const meeting = { id: 'meeting-1' };
    const component = new ChatComponent({
        isGuestSession: () => false,
        getState: () => state,
        setState: (updates) => Object.assign(state, updates),
        getSelectedMeeting: () => meeting,
        getSession: () => state.session,
        renderFeedLists: () => {},
        publishRealtimePayload: async () => {},
        loadMeetingDetails: async () => {},
        getRoom: () => null,
        getActiveBoardId: () => 'board-1',
        runTool: async (name, args) => {
            calls.push({ name, args });
            if (name === 'webmeet_chat_send') {
                return {
                    message: {
                        id: 'chat-1',
                        meetingId: args.meetingId,
                        authorId: 'p-1',
                        authorName: 'User One',
                        message: args.message,
                        createdAt: '2026-01-01T00:00:00.000Z'
                    }
                };
            }
            return {};
        },
        ...overrides
    });
    return { component, calls, state, meeting };
}

test('sendChat persists messages through webmeet_chat_send', async () => {
    const { component, calls, meeting } = makeComponent();
    component.elements = { chatInput: { value: 'hello @open-interpreter' } };
    await component.sendChat();
    assert.equal(calls.length, 1, 'sendChat should invoke exactly one tool');
    assert.equal(calls[0].name, 'webmeet_chat_send', 'WebMeet must route chat through webmeet_chat_send');
    assert.equal(calls[0].args.meetingId, meeting.id);
    assert.equal(calls[0].args.authorId, 'p-1');
    assert.equal(calls[0].args.message, 'hello @open-interpreter');
});

test('sendChat clears the chat input after a successful send', async () => {
    const { component } = makeComponent();
    component.elements = { chatInput: { value: 'note' } };
    await component.sendChat();
    assert.equal(component.elements.chatInput.value, '');
});

test('chat attachment upload stages in Explorer and publishes one chat and Blackboard result', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ id: 'b'.repeat(48), agent: 'explorer', localPath: `blobs/${'b'.repeat(48)}` })
    });
    let refreshOptions = null;
    const { component, calls, state } = makeComponent({
        refreshBlackboard: async (_result, options) => { refreshOptions = options; },
        runTool: async (name, args) => {
            calls.push({ name, args });
            return {
                message: { id: 'chat-image', message: 'photo.png', metadata: { attachments: [{ kind: 'image' }] } },
                blackboard: { revision: 4, widgets: [] }
            };
        }
    });
    const classList = { toggle() {} };
    component.elements = { chatAttachmentButton: { disabled: false, classList, setAttribute() {} } };
    try {
        await component.publishAttachments([{ name: 'photo.png', type: 'image/png', size: 24 }]);
    } finally {
        globalThis.fetch = previousFetch;
    }
    assert.equal(calls[0].name, 'webmeet_attachment_publish');
    assert.deepEqual(calls[0].args.blobRef, {
        id: 'b'.repeat(48),
        agent: 'explorer',
        localPath: `blobs/${'b'.repeat(48)}`
    });
    assert.equal(state.chat[0].id, 'chat-image');
    assert.deepEqual(refreshOptions, { ensureVisible: true });
});

test('chat paste and composer drop publish every transferred file', async () => {
    const { component } = makeComponent();
    const input = createListenerTarget();
    input.files = [];
    input.value = '';
    const composer = createListenerTarget();
    const overlayAttributes = new Map();
    const overlay = {
        hidden: true,
        setAttribute: (name, value) => overlayAttributes.set(name, value),
    };
    const batches = [];
    component.publishAttachments = async (files) => { batches.push(files.map((file) => file.name)); };
    component.setElements({
        chatComposer: composer,
        chatInput: { value: '' },
        chatFileInput: input,
        chatDropOverlay: overlay,
    });

    let pastePrevented = 0;
    composer.dispatch('paste', {
        clipboardData: {
            items: [
                { kind: 'string', type: 'text/plain' },
                { kind: 'file', type: 'image/png', getAsFile: () => ({ name: 'paste-1.png' }) },
                { kind: 'file', type: 'image/jpeg', getAsFile: () => ({ name: 'paste-2.jpg' }) },
            ],
        },
        preventDefault: () => { pastePrevented += 1; },
    });

    assert.equal(pastePrevented, 1);
    assert.deepEqual(batches[0], ['paste-1.png', 'paste-2.jpg']);

    composer.dispatch('paste', {
        clipboardData: { items: [{ kind: 'string', type: 'text/plain' }] },
        preventDefault: () => { pastePrevented += 1; },
    });
    assert.equal(pastePrevented, 1, 'text-only paste must retain the native textarea behavior');

    const dragTransfer = { types: ['Files'], files: [{ name: 'drop-1.webp' }, { name: 'drop-2.gif' }] };
    composer.dispatch('dragenter', { dataTransfer: dragTransfer, preventDefault() {} });
    composer.dispatch('dragenter', { dataTransfer: dragTransfer, preventDefault() {} });
    composer.dispatch('dragover', { dataTransfer: dragTransfer, preventDefault() {} });
    assert.equal(dragTransfer.dropEffect, 'copy');
    assert.equal(overlay.hidden, false);
    assert.equal(composer.classList.contains('is-attachment-drag-active'), true);
    composer.dispatch('dragleave', { preventDefault() {} });
    assert.equal(overlay.hidden, false, 'nested dragleave must not hide the overlay');
    let dropStopped = 0;
    composer.dispatch('drop', {
        dataTransfer: dragTransfer,
        preventDefault() {},
        stopPropagation: () => { dropStopped += 1; },
    });

    assert.equal(dropStopped, 1);
    assert.equal(overlay.hidden, true);
    assert.equal(overlayAttributes.get('aria-hidden'), 'true');
    assert.deepEqual(batches[1], ['drop-1.webp', 'drop-2.gif']);

    input.files = [{ name: 'picker.png' }];
    composer.dispatch('dragleave', { preventDefault() {} });
    input.dispatch('change');
    assert.deepEqual(batches[2], ['picker.png']);
    assert.equal(input.value, '');

    component.destroyAttachmentUpload();
    assert.equal(composer.listeners.size, 0);
    assert.equal(input.listeners.size, 0);
});

test('attachment upload queue accepts generic files, continues after one failure and preserves order', async () => {
    const previousFetch = globalThis.fetch;
    const fetched = [];
    globalThis.fetch = async (_url, options) => {
        const filename = options.body.name;
        fetched.push(filename);
        if (filename === 'broken.png') {
            return { ok: false, status: 500, text: async () => 'temporary failure' };
        }
        return {
            ok: true,
            json: async () => ({ id: filename, agent: 'explorer', localPath: `blobs/${filename}` }),
        };
    };
    const errors = [];
    const published = [];
    let refreshCount = 0;
    const { component, state } = makeComponent({
        setError: (message) => { errors.push(message); },
        refreshBlackboard: async () => { refreshCount += 1; },
        runTool: async (_name, args) => {
            published.push(args.blobRef.id);
            return {
                message: { id: `chat-${args.blobRef.id}`, message: args.blobRef.id },
                blackboard: { revision: published.length, widgets: [] },
            };
        },
    });
    const busyStates = [];
    component.elements = {
        chatAttachmentButton: {
            disabled: false,
            classList: { toggle(_name, active) { busyStates.push(active); } },
            setAttribute() {},
        },
    };

    try {
        await component.publishAttachments([
            { name: 'first.png', type: 'image/png', size: 10 },
            { name: 'notes.txt', type: 'text/plain', size: 10 },
            { name: 'broken.png', type: 'image/png', size: 10 },
            { name: 'last.jpg', type: 'image/jpeg', size: 10 },
        ]);
    } finally {
        globalThis.fetch = previousFetch;
    }

    assert.deepEqual(fetched, ['first.png', 'notes.txt', 'broken.png', 'last.jpg']);
    assert.deepEqual(published, ['first.png', 'notes.txt', 'last.jpg']);
    assert.equal(state.chat.length, 3);
    assert.equal(refreshCount, 3);
    assert.match(errors[0], /temporary failure/);
    assert.deepEqual(busyStates, [true, false]);
});

test('/robo awaits a requested browser-side group insertion before reporting success', async () => {
    let clientAction = null;
    const statuses = [];
    const { component } = makeComponent({
        executeBlackboardClientAction: async (action) => { clientAction = action; },
        updateRoboCommandStatus: async (status) => { statuses.push(status.state); },
        runTool: async () => ({
            ok: true,
            clientAction: { type: 'scripta-insert-group', groupId: 'group-1', alt: 'Diagram' }
        })
    });
    component.elements = { chatInput: { value: '/robo insert group 1 into SCRIPTA' } };
    await component.sendChat();
    assert.deepEqual(clientAction, { type: 'scripta-insert-group', groupId: 'group-1', alt: 'Diagram' });
    assert.deepEqual(statuses, ['started', 'success']);
});

test('/robo uses the canonical event command and upserts its audit message', async () => {
    let chatWasRendered = false;
    const { component, calls, state } = makeComponent({
        renderFeedLists: () => {
            chatWasRendered = state.chat.some((entry) => entry.kind === 'event');
        }
    });
    component.runTool = async (name, args) => {
        calls.push({ name, args });
        return {
            ok: true,
            auditMessage: { id: 'event-chat-1', kind: 'event', message: '/robo add a SCRIPTA document', metadata: { status: 'success' } }
        };
    };
    component.elements = { chatInput: { value: '/robo add a SCRIPTA document' } };

    await component.sendChat();

    assert.deepEqual(calls.map((entry) => entry.name), ['webmeet_event_command']);
    assert.equal(calls[0].args.source, 'robo');
    assert.equal(state.chat.length, 1);
    assert.equal(state.chat[0].message, '/robo add a SCRIPTA document');
    assert.equal(chatWasRendered, true);
    assert.equal(component.elements.chatInput.value, '');
});

test('/robo reports started and success with one stable command id', async () => {
    const statuses = [];
    const { component, calls } = makeComponent({
        updateRoboCommandStatus: async (status) => { statuses.push(status); }
    });
    component.runTool = async (name, args) => {
        calls.push({ name, args });
        return { ok: true, auditMessage: { id: 'audit-status', kind: 'event', message: args.event, metadata: { status: 'success' } } };
    };
    component.elements = { chatInput: { value: '/robo move line 3 right' } };

    await component.sendChat();
    await Promise.resolve();

    assert.deepEqual(statuses.map((entry) => entry.state), ['started', 'success']);
    assert.equal(statuses[0].commandId, statuses[1].commandId);
    assert.equal(calls[0].args.commandId, statuses[0].commandId);
});

test('typing the /robo prefix activates widget ordinals before submit', () => {
    const draftStates = [];
    const { component } = makeComponent({
        updateRoboDraftState: (active) => draftStates.push(active)
    });
    component.elements = { chatInput: { value: '/robo' } };
    component.updateComposerMentionOverlay();
    component.elements.chatInput.value = '/robot';
    component.updateComposerMentionOverlay();

    assert.deepEqual(draftStates, [true, false]);
});

test('room entry reports denied push-to-talk microphone permission without throwing', async () => {
    let errorMessage = '';
    const { component } = makeComponent({
        setError: (message) => { errorMessage = message; }
    });
    component.roboSpeechInput = {
        prepareMicrophonePermission: async () => ({ status: 'denied', requested: false })
    };

    const result = await component.prepareRoboMicrophonePermission();

    assert.equal(result.status, 'denied');
    assert.match(errorMessage, /Push-to-talk will remain unavailable/);
});

test('/robo reports the explicit server error as its terminal status', async () => {
    const statuses = [];
    const { component } = makeComponent({
        setError: () => {},
        updateRoboCommandStatus: async (status) => { statuses.push(status); },
        runTool: async () => ({ ok: false, error: { code: 'ambiguous_target', message: 'There are multiple lines.' } })
    });
    component.elements = { chatInput: { value: '/robo move the line' } };

    await component.sendChat();
    await Promise.resolve();

    assert.deepEqual(statuses.map((entry) => entry.state), ['started', 'error']);
    assert.equal(statuses[1].errorMessage, 'There are multiple lines.');
});

test('/robo reports an active workspace lookup failure without rejecting sendChat', async () => {
    let errorMessage = '';
    const { component } = makeComponent({
        getActiveBoardId: () => '',
        setError: (message) => { errorMessage = message; },
        runTool: async (name) => {
            assert.equal(name, 'webmeet_blackboard_workspace_get');
            throw new Error('Workspace read failed.');
        },
    });
    component.elements = { chatInput: { value: '/robo move the shape' } };

    await assert.doesNotReject(() => component.sendChat());

    assert.match(errorMessage, /Workspace read failed/);
    assert.equal(component.elements.chatInput.value, '/robo move the shape');
});

test('/robo event error remains available as an audit message', async () => {
    const state = { chat: [], session: { participantIdentity: 'p-1', participant: { displayName: 'User One' } } };
    let errorMessage = '';
    const component = new ChatComponent({
        isGuestSession: () => false,
        getState: () => state,
        getSelectedMeeting: () => ({ id: 'meeting-1' }),
        getSession: () => state.session,
        renderFeedLists: () => {},
        loadMeetingDetails: async () => {},
        getRoom: () => null,
        getActiveBoardId: () => 'board-1',
        setError: (message) => { errorMessage = message; },
        runTool: async () => ({
            ok: false,
            error: { message: 'AI unavailable' },
            auditMessage: { id: 'chat-robo', kind: 'event', message: '/robo do something', metadata: { status: 'error' } }
        })
    });
    component.elements = { chatInput: { value: '/robo do something' } };

    await component.sendChat();

    assert.equal(state.chat[0].message, '/robo do something');
    assert.match(errorMessage, /AI unavailable/);
});

test('/robo command applies the open blackboard and broadcasts its revision', async () => {
    const { component, state } = makeComponent();
    const published = [];
    let refreshResult = null;
    component.getRoom = () => ({ localParticipant: { identity: 'p-1' } });
    component.publishRealtimePayload = async (payload) => { published.push(payload); };
    component.refreshBlackboard = async (result) => { refreshResult = result; };
    component.runTool = async (name, args) => {
        return {
            ok: true,
            auditMessage: { id: 'chat-live', kind: 'event', message: args.event, metadata: { status: 'success' } },
            visibilityPayload: { type: 'blackboard.visibility_changed', visible: true },
            blackboard: { boardId: 'board-1', revision: 42, widgets: [] }
        };
    };
    component.elements = { chatInput: { value: '/robo go to next paragraph' } };

    await component.sendChat();

    assert.equal(state.chat[0].message, '/robo go to next paragraph');
    assert.equal(refreshResult.blackboard.revision, 42);
    const update = published.find((payload) => payload.type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(update.boardId, 'board-1');
    assert.equal(update.blackboardRevision, 42);
    assert.equal(published.some((payload) => payload.type === WEBMEET_EVENT_TYPES.BLACKBOARD_VISIBILITY_CHANGED), false);
});

test('sendChat renders returned store message before detail refresh completes', async () => {
    let resolveRefresh;
    const refreshStarted = new Promise((resolve) => {
        resolveRefresh = resolve;
    });
    let renderCount = 0;
    const { component, state } = makeComponent({
        renderFeedLists: () => {
            renderCount += 1;
        },
        loadMeetingDetails: async () => {
            await refreshStarted;
        }
    });
    component.elements = { chatInput: { value: 'instant' } };
    await component.sendChat();

    assert.equal(state.chat.length, 1);
    assert.equal(state.chat[0].message, 'instant');
    assert.equal(renderCount, 1);
    resolveRefresh();
});

test('sendChat does not call any tool when the input is empty', async () => {
    const { component, calls } = makeComponent();
    component.elements = { chatInput: { value: '   ' } };
    await component.sendChat();
    assert.equal(calls.length, 0);
});

test('getKnownAgentTokens returns no provider tokens', () => {
    const { component } = makeComponent();
    assert.deepEqual(component.getKnownAgentTokens(), []);
});

test('composer mention overlay bolds only selected file mentions', () => {
    const { component } = makeComponent();
    component.mentionOverlay = { innerHTML: '', scrollTop: 0, scrollLeft: 0 };
    component.mentionOverlayInput = {
        value: 'ask @open-interpreter and @file:docs/readme.md',
        scrollTop: 7,
        scrollLeft: 2
    };
    component.recordSelectedMention('@file:docs/readme.md');

    component.updateComposerMentionOverlay();

    assert.doesNotMatch(component.mentionOverlay.innerHTML,
        /<strong class="webmeet-composer-mention">@open-interpreter<\/strong>/);
    assert.match(component.mentionOverlay.innerHTML,
        /<strong class="webmeet-composer-mention">@file:docs\/readme\.md<\/strong>/);
    assert.equal(component.mentionOverlay.scrollTop, 7);
    assert.equal(component.mentionOverlay.scrollLeft, 2);
});

test('composer mention overlay prunes selected mentions removed from the input', () => {
    const { component } = makeComponent();
    component.mentionOverlay = { innerHTML: '', scrollTop: 0, scrollLeft: 0 };
    component.mentionOverlayInput = { value: 'ask @open-interpreter', scrollTop: 0, scrollLeft: 0 };
    component.recordSelectedMention('@file:docs/readme.md');

    component.updateComposerMentionOverlay();

    assert.equal(component.selectedMentionTokens.has('@file:docs/readme.md'), false);
});
