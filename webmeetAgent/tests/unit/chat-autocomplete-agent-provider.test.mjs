import test from 'node:test';
import assert from 'node:assert/strict';

import {
    WEBMEET_CANONICAL_AGENT_TAGS,
    applyAgentTagSelection,
    createAgentTagProvider
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/chat-autocomplete/agent-tag-provider.js';

test('canonical catalog ships @open-interpreter for the research relay', () => {
    const tags = WEBMEET_CANONICAL_AGENT_TAGS.map((entry) => entry.tag);
    assert.ok(tags.includes('open-interpreter'),
        '@open-interpreter must be exposed as the default WebMeet research relay tag');
});

test('agent provider returns the canonical @open-interpreter suggestion for an empty token', () => {
    const provider = createAgentTagProvider();
    const suggestions = provider.getSuggestions('@', 1, { trigger: '@', triggerIndex: 0, token: '' });
    assert.ok(suggestions.length >= 1, 'provider should surface at least the canonical tag');
    const labels = suggestions.map((entry) => entry.label);
    assert.ok(labels.includes('@open-interpreter'));
});

test('agent provider filters suggestions against the current trigger token', () => {
    const provider = createAgentTagProvider();
    const suggestions = provider.getSuggestions('@open', 5, { trigger: '@', triggerIndex: 0, token: 'open' });
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].label, '@open-interpreter');
});

test('agent provider returns no suggestions for non-@ trigger', () => {
    const provider = createAgentTagProvider();
    const suggestions = provider.getSuggestions('/build', 6, { trigger: '/', triggerIndex: 0, token: 'build' });
    assert.deepEqual(suggestions, []);
});

test('agent provider returns no suggestions when the token already contains a path separator', () => {
    const provider = createAgentTagProvider();
    const suggestions = provider.getSuggestions('@file:docs/', 11, { trigger: '@', triggerIndex: 0, token: 'file:docs/' });
    assert.deepEqual(suggestions, []);
});

test('applyAgentTagSelection inserts the canonical tag with trailing space and consumes the typed token', () => {
    const next = applyAgentTagSelection('@op', 'open-interpreter', { trigger: '@', triggerIndex: 0, token: 'op' });
    assert.deepEqual(next, {
        value: '@open-interpreter ',
        cursor: '@open-interpreter '.length,
        token: '@open-interpreter'
    });
});

test('applyAgentTagSelection keeps surrounding text intact', () => {
    const next = applyAgentTagSelection('please ask @op for details', 'open-interpreter', { trigger: '@', triggerIndex: 11, token: 'op' });
    assert.equal(next.value, 'please ask @open-interpreter for details');
});

test('applyAgentTagSelection rejects tags that do not match the canonical TAG_NAME pattern', () => {
    const next = applyAgentTagSelection('@op', 'Not A Tag', { trigger: '@', triggerIndex: 0, token: 'op' });
    assert.equal(next, null);
});

test('agent provider catalog accepts overrides while normalising entries', () => {
    const provider = createAgentTagProvider({
        tags: [
            { tag: '@CodeReviewer', label: 'Code reviewer' },
            { tag: 'bad tag', label: 'invalid' },
            { tag: 'open-interpreter' }
        ]
    });
    const labels = provider.getSuggestions('@', 1, { trigger: '@', triggerIndex: 0, token: '' }).map((entry) => entry.label);
    assert.ok(labels.includes('Code reviewer'));
    assert.ok(labels.includes('@open-interpreter'));
    assert.equal(labels.includes('invalid'), false);
});

test('getKnownTokens lists every canonical mention used for bold rendering', () => {
    const provider = createAgentTagProvider();
    assert.deepEqual(provider.getKnownTokens(), ['@open-interpreter']);
});
