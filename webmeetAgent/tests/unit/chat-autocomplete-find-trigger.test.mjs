import test from 'node:test';
import assert from 'node:assert/strict';

import { findTriggerAt } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/chat-autocomplete/find-trigger.js';

test('findTriggerAt detects @ at the start of input', () => {
    const result = findTriggerAt('@op', 3, ['@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 0, token: 'op' });
});

test('findTriggerAt detects @ after whitespace', () => {
    const result = findTriggerAt('ask @open-i', 11, ['@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 4, token: 'open-i' });
});

test('findTriggerAt ignores @ embedded in an email address', () => {
    const result = findTriggerAt('user@example.com', 16, ['@']);
    assert.equal(result, null);
});

test('findTriggerAt ignores a trigger separated from caret by a newline', () => {
    const result = findTriggerAt('@line1\n more', 11, ['@']);
    assert.equal(result, null);
});

test('findTriggerAt returns an empty token when caret sits on the trigger', () => {
    const result = findTriggerAt('hello @', 7, ['@']);
    assert.deepEqual(result, { trigger: '@', triggerIndex: 6, token: '' });
});
