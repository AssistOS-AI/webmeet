import test from 'node:test';
import assert from 'node:assert/strict';

import {
    applyWorkspacePathSelection,
    createWorkspacePathsProvider
} from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/chat-autocomplete/workspace-paths-provider.js';

function makeTriggerInfo(value) {
    const idx = value.lastIndexOf('@');
    return idx >= 0 ? { trigger: '@', triggerIndex: idx, token: value.slice(idx + 1) } : null;
}

test('applyWorkspacePathSelection inserts a file: token for files with trailing space', () => {
    const triggerInfo = makeTriggerInfo('see @no');
    const next = applyWorkspacePathSelection('see @no', 'notes.md', 'file', triggerInfo);
    assert.equal(next.value, 'see @file:notes.md ');
    assert.equal(next.cursor, 'see @file:notes.md '.length);
});

test('applyWorkspacePathSelection keeps folder selections open with a trailing slash', () => {
    const triggerInfo = makeTriggerInfo('@do');
    const next = applyWorkspacePathSelection('@do', 'docs', 'folder', triggerInfo);
    assert.equal(next.value, '@file:docs/');
});

test('createWorkspacePathsProvider exposes nothing until a request resolves', async () => {
    const provider = createWorkspacePathsProvider({
        searchPaths: async () => ([
            { path: 'docs/notes.md', kind: 'file' },
            { path: 'docs/api', kind: 'folder' }
        ])
    });
    assert.ok(provider, 'provider should be created when searchPaths is provided');
    const triggerInfo = { trigger: '@', triggerIndex: 0, token: 'docs' };
    assert.deepEqual(provider.getSuggestions('@docs', 5, triggerInfo), []);
    const fetched = await provider.requestSuggestions('@docs', triggerInfo);
    assert.equal(fetched.length, 2);
    const suggestions = provider.getSuggestions('@docs', 5, triggerInfo);
    assert.equal(suggestions.length, 2);
    assert.deepEqual(suggestions.map((entry) => entry.group), ['Files and folders', 'Files and folders']);
});

test('createWorkspacePathsProvider preserves folder behavior from Explorer metadata', async () => {
    const provider = createWorkspacePathsProvider({
        searchPaths: async () => ([
            { path: 'docs/api', kind: 'folder' },
            { path: 'docs/readme.md', kind: 'file' }
        ])
    });
    const triggerInfo = { trigger: '@', triggerIndex: 0, token: 'docs' };
    await provider.requestSuggestions('@docs', triggerInfo);
    const suggestions = provider.getSuggestions('@docs', 5, triggerInfo);
    const folder = suggestions.find((entry) => entry.label === 'docs/api/');
    const file = suggestions.find((entry) => entry.label === 'docs/readme.md');
    assert.equal(folder.keepMenuOpen, true);
    assert.equal(folder.description, 'Folder');
    assert.equal(file.keepMenuOpen, false);
    assert.equal(file.description, 'File');
});

test('createWorkspacePathsProvider returns null without a searchPaths function', () => {
    assert.equal(createWorkspacePathsProvider({}), null);
});
