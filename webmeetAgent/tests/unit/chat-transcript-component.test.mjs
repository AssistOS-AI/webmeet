import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatTranscriptComponent } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/service-components/chat-transcript-component.js';

function makeComponent(overrides = {}) {
    const state = { chat: [], transcript: [], session: { participantIdentity: 'p-1', participant: { displayName: 'User One' } } };
    const calls = [];
    const meeting = { id: 'meeting-1' };
    const component = new ChatTranscriptComponent({
        isGuestSession: () => false,
        canManageArtifacts: () => true,
        getState: () => state,
        setState: (updates) => Object.assign(state, updates),
        getSelectedMeeting: () => meeting,
        getSession: () => state.session,
        renderFeedLists: () => {},
        renderMeetingSummary: () => {},
        renderAll: () => {},
        publishRealtimePayload: async () => {},
        loadMeetingDetails: async () => {},
        getRoom: () => null,
        runTool: async (name, args) => {
            calls.push({ name, args });
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

test('sendChat does not call any tool when the input is empty', async () => {
    const { component, calls } = makeComponent();
    component.elements = { chatInput: { value: '   ' } };
    await component.sendChat();
    assert.equal(calls.length, 0);
});

test('appendTranscript routes through webmeet_transcript_append', async () => {
    const { component, calls, meeting } = makeComponent();
    component.elements = {
        chatInput: { value: '' },
        transcriptInput: { value: 'spoken' },
        transcriptSpeaker: { value: 'Speaker' }
    };
    await component.appendTranscript();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'webmeet_transcript_append');
    assert.equal(calls[0].args.meetingId, meeting.id);
});

test('getKnownAgentTokens returns the canonical @open-interpreter token', () => {
    const { component } = makeComponent();
    assert.deepEqual(component.getKnownAgentTokens(), ['@open-interpreter']);
});

test('composer mention overlay bolds known and selected mentions', () => {
    const { component } = makeComponent();
    component.mentionOverlay = { innerHTML: '', scrollTop: 0, scrollLeft: 0 };
    component.mentionOverlayInput = {
        value: 'ask @open-interpreter and @file:docs/readme.md',
        scrollTop: 7,
        scrollLeft: 2
    };
    component.recordSelectedMention('@file:docs/readme.md');

    component.updateComposerMentionOverlay();

    assert.match(component.mentionOverlay.innerHTML,
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
