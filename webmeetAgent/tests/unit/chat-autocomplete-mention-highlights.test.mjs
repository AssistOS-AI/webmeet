import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extractMentionTokenAt,
    findMentionRanges,
    normalizeMentionToken,
    renderComposerMentionOverlayHtml,
    renderMessageWithMentionHighlights
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/chat-autocomplete/mention-highlights.js';

test('normalizeMentionToken keeps valid @tag tokens and drops whitespace', () => {
    assert.equal(normalizeMentionToken('@open-interpreter'), '@open-interpreter');
    assert.equal(normalizeMentionToken('@'), '');
    assert.equal(normalizeMentionToken('open-interpreter'), '');
    assert.equal(normalizeMentionToken(' @op '), '@op');
    assert.equal(normalizeMentionToken('@one two'), '');
});

test('extractMentionTokenAt returns the canonical mention before trailing space', () => {
    assert.equal(extractMentionTokenAt('@open-interpreter ', 18), '@open-interpreter');
    assert.equal(extractMentionTokenAt('see @file:docs/notes.md ', 24), '@file:docs/notes.md');
});

test('findMentionRanges detects sent-message agent and path mentions', () => {
    assert.deepEqual(findMentionRanges('ask @open-interpreter hello'), [
        { start: 4, end: 21, token: '@open-interpreter' }
    ]);
    assert.deepEqual(findMentionRanges('read @file:webmeetAgent/server'), [
        { start: 5, end: 30, token: '@file:webmeetAgent/server' }
    ]);
});

test('findMentionRanges ignores @ embedded inside an email', () => {
    assert.deepEqual(findMentionRanges('email user@example.com about @open-interpreter'), [
        { start: 29, end: 46, token: '@open-interpreter' }
    ]);
});

test('renderMessageWithMentionHighlights bolds known canonical agent tokens', () => {
    const html = renderMessageWithMentionHighlights('ask @open-interpreter please', ['@open-interpreter']);
    assert.match(html, /<strong class="webmeet-chat-mention">@open-interpreter<\/strong>/);
});

test('renderMessageWithMentionHighlights leaves unknown mentions plain', () => {
    const html = renderMessageWithMentionHighlights('ping @teammate now', ['@open-interpreter']);
    assert.equal(html, 'ping @teammate now');
});

test('renderMessageWithMentionHighlights escapes HTML in plain content', () => {
    const html = renderMessageWithMentionHighlights('<script>alert(1)</script> @open-interpreter', ['@open-interpreter']);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /<strong class="webmeet-chat-mention">@open-interpreter<\/strong>/);
});

test('renderComposerMentionOverlayHtml only bolds tokens that were selected', () => {
    const html = renderComposerMentionOverlayHtml('@open-interpreter and @teammate', ['@open-interpreter']);
    assert.match(html, /<strong class="webmeet-composer-mention">@open-interpreter<\/strong>/);
    assert.doesNotMatch(html, /<strong[^>]*>@teammate<\/strong>/);
});
