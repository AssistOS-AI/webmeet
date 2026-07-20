import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatComponent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/chat-component.js';
import { WEBMEET_EVENT_TYPES } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-events.js';

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

test('/robo command refreshes the open blackboard and broadcasts its new version', async () => {
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
            blackboard: { version: 42, widgets: [] }
        };
    };
    component.elements = { chatInput: { value: '/robo go to next paragraph' } };

    await component.sendChat();

    assert.equal(state.chat[0].message, '/robo go to next paragraph');
    assert.equal(refreshResult.blackboard.version, 42);
    const update = published.find((payload) => payload.type === WEBMEET_EVENT_TYPES.BLACKBOARD_UPDATED);
    assert.equal(update.boardId, 'agent:agent_robo_team');
    assert.equal(update.blackboardVersion, 42);
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
