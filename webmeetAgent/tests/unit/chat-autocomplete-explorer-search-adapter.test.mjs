import test from 'node:test';
import assert from 'node:assert/strict';

import { createExplorerSearchAdapter } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/services/chat-autocomplete/explorer-search-adapter.js';

test('Explorer search adapter requests raw search_files payloads without the global loader', async () => {
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args, options) => {
            calls.push({ name, args, options });
            if (name === 'search_files') {
                return { content: [{ type: 'text', text: JSON.stringify({ results: ['/docs'] }) }] };
            }
            return { content: [{ type: 'text', text: JSON.stringify({ isDirectory: true }) }] };
        }
    });

    const results = await adapter.searchPaths('docs');
    assert.equal(results.length, 1);
    assert.equal(calls[0].name, 'search_files');
    assert.deepEqual(calls[0].options, { raw: true, withLoader: false });
});

test('Explorer search adapter classifies string search results with get_file_info', async () => {
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args) => {
            if (name === 'search_files') {
                return { content: [{ type: 'text', text: JSON.stringify({ results: ['/docs', '/docs/readme.md'] }) }] };
            }
            if (name === 'get_file_info' && args.path === '/docs') {
                return { content: [{ type: 'text', text: JSON.stringify({ isDirectory: true, isFile: false }) }] };
            }
            if (name === 'get_file_info' && args.path === '/docs/readme.md') {
                return { content: [{ type: 'text', text: JSON.stringify({ isDirectory: false, isFile: true }) }] };
            }
            return { content: [{ type: 'text', text: '{}' }] };
        }
    });

    const results = await adapter.searchPaths('docs');
    assert.deepEqual(results.map((entry) => `${entry.kind}:${entry.path}`), [
        'folder:docs',
        'file:docs/readme.md'
    ]);
});

test('Explorer search adapter scopes nested folder searches to the selected folder', async () => {
    const calls = [];
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name, args, options) => {
            calls.push({ name, args, options });
            if (name === 'search_files') {
                return { json: { results: ['/docs/api.md'] } };
            }
            return { json: { isFile: true, isDirectory: false } };
        }
    });

    await adapter.searchPaths('docs/api');
    assert.equal(calls[0].name, 'search_files');
    assert.equal(calls[0].args.path, '/docs');
    assert.equal(calls[0].args.pattern, 'api');
});

test('Explorer search adapter accepts default string JSON payloads as a compatibility fallback', async () => {
    const adapter = createExplorerSearchAdapter({
        resolveWorkspaceRoot: async () => '/',
        callExplorerTool: async (name) => {
            if (name === 'search_files') {
                return JSON.stringify({ results: ['/notes.md'] });
            }
            return JSON.stringify({ isFile: true });
        }
    });

    const results = await adapter.searchPaths('notes');
    assert.deepEqual(results, [{
        path: 'notes.md',
        label: 'notes.md',
        displayPath: 'notes.md',
        kind: 'file'
    }]);
});
