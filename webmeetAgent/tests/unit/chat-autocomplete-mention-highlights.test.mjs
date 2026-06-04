import test from 'node:test';
import assert from 'node:assert/strict';

import {
    extractMentionTokenAt,
    findMentionRanges,
    normalizeMentionToken,
    renderComposerMentionOverlayHtml,
    renderMessageWithMentionHighlights
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/chat-autocomplete/mention-highlights.js';

test('normalizeMentionToken keeps file tokens and drops provider-looking tokens', () => {
    assert.equal(normalizeMentionToken('@open-interpreter'), '');
    assert.equal(normalizeMentionToken('@file:docs/notes.md'), '@file:docs/notes.md');
    assert.equal(normalizeMentionToken('@'), '');
    assert.equal(normalizeMentionToken('open-interpreter'), '');
    assert.equal(normalizeMentionToken(' @op '), '');
    assert.equal(normalizeMentionToken('@one two'), '');
});

test('extractMentionTokenAt returns file mentions and ignores provider-looking tokens', () => {
    assert.equal(extractMentionTokenAt('@open-interpreter ', 18), '');
    assert.equal(extractMentionTokenAt('see @file:docs/notes.md ', 24), '@file:docs/notes.md');
});

test('findMentionRanges detects file mentions and ignores provider-looking tokens', () => {
    assert.deepEqual(findMentionRanges('ask @open-interpreter hello'), []);
    assert.deepEqual(findMentionRanges('read @file:webmeetAgent/server'), [
        { start: 5, end: 30, token: '@file:webmeetAgent/server' }
    ]);
});

test('findMentionRanges ignores @ embedded inside an email', () => {
    assert.deepEqual(findMentionRanges('email user@example.com about @open-interpreter'), []);
});

test('renderMessageWithMentionHighlights leaves provider-looking tokens plain', () => {
    const html = renderMessageWithMentionHighlights('ask @open-interpreter please', ['@open-interpreter']);
    assert.equal(html, 'ask @open-interpreter please');
});

test('renderMessageWithMentionHighlights leaves unknown mentions plain', () => {
    const html = renderMessageWithMentionHighlights('ping @teammate now', ['@open-interpreter']);
    assert.equal(html, 'ping @teammate now');
});

test('renderMessageWithMentionHighlights escapes HTML in plain content', () => {
    const html = renderMessageWithMentionHighlights('<script>alert(1)</script> @open-interpreter', ['@open-interpreter']);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<strong class="webmeet-chat-mention">@open-interpreter<\/strong>/);
});

test('renderComposerMentionOverlayHtml only bolds selected file tokens', () => {
    const html = renderComposerMentionOverlayHtml('@open-interpreter and @file:docs/notes.md', ['@open-interpreter', '@file:docs/notes.md']);
    assert.doesNotMatch(html, /<strong class="webmeet-composer-mention">@open-interpreter<\/strong>/);
    assert.match(html, /<strong class="webmeet-composer-mention">@file:docs\/notes\.md<\/strong>/);
    assert.doesNotMatch(html, /<strong[^>]*>@teammate<\/strong>/);
});
