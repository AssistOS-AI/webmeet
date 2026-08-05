import assert from 'node:assert/strict';
import test from 'node:test';

import { action } from '../skills/meeting-notes/src/index.mjs';

const context = {
    structurePrompt: 'Create a meeting title followed by these chapters: Summary; Ideas and proposals; Decisions; Questions; Risks; Actions; Unresolved points.',
    participants: [{ participantId: 'p1', displayName: 'Ana' }],
    journal: [{ segmentId: 's1', participantId: 'p1', displayName: 'Ana', text: 'Propun sa lansam marti.' }],
    currentMarkdown: '# Previous\n\n## Summary\n\nOld notes.',
};

const markdown = `# Lansare\n\n## Summary\n\nAna a propus lansarea marți.\n\n## Ideas and proposals\n\n- **Ana:** Propune lansarea marți.\n\n## Decisions\n\n- None yet.\n\n## Questions\n\n- None yet.\n\n## Risks\n\n- None yet.\n\n## Actions\n\n- None yet.\n\n## Unresolved points\n\n- None yet.`;

test('meeting-notes requests and returns a complete Markdown document', async () => {
    let prompt = '';
    const result = await action({
        context,
        llmAgent: {
            invokerStrategy: { listAvailableModels: () => ({ models: [] }) },
            async executePrompt(value) {
                prompt = value;
                return markdown;
            },
        },
    });
    assert.equal(result, markdown);
    assert.match(prompt, /Configured document structure/);
    assert.match(prompt, /Ideas and proposals/);
    assert.match(prompt, /Current Markdown document/);
    assert.doesNotMatch(prompt, /Return exactly the schema object/);
});

test('meeting-notes accepts a wrapped complete Markdown response', async () => {
    const result = await action({
        context,
        llmAgent: {
            async executePrompt() { return { result: markdown }; },
        },
    });
    assert.equal(result, markdown);
});

test('meeting-notes accepts the structure requested by the editable prompt', async () => {
    const customMarkdown = '# Notes\n\n## Highlights\n\n- **Ana:** Propune lansarea marți.';
    const result = await action({
        context: { ...context, structurePrompt: 'Create a meeting title followed by one chapter named Highlights.' },
        llmAgent: { async executePrompt() { return customMarkdown; } },
    });
    assert.equal(result, customMarkdown);
});

test('meeting-notes rejects output without a Markdown document title', async () => {
    await assert.rejects(
        action({ context, llmAgent: { async executePrompt() { return 'A short summary.'; } } }),
        /must begin with a document title/,
    );
});

test('meeting-notes rejects a title that is preceded by prose or duplicated', async () => {
    await assert.rejects(
        action({ context, llmAgent: { async executePrompt() { return `Preface\n${markdown}`; } } }),
        /must begin with a document title/,
    );
    await assert.rejects(
        action({ context, llmAgent: { async executePrompt() { return `${markdown}\n\n# Duplicate`; } } }),
        /exactly one H1/,
    );
});

test('meeting-notes rejects missing, reordered, or omitted configured chapters', async () => {
    await assert.rejects(
        action({ context, llmAgent: { async executePrompt() { return '# Notes\n\n## Summary\n\nAna propune lansarea marți.'; } } }),
        /configured chapter structure/,
    );
});

test('meeting-notes accepts structurally valid Markdown without lexical topic matching', async () => {
    const twoTopics = {
        ...context,
        journal: [
            { segmentId: 'health', text: 'Visceral fat increases mortality risk.' },
            { segmentId: 'workflow', text: 'Next topic local agentic coding workflow uses GPU VRAM.' },
        ],
    };
    assert.equal(
        await action({ context: twoTopics, llmAgent: { async executePrompt() { return markdown; } } }),
        markdown,
    );
});

test('meeting-notes requires the configured document structure', async () => {
    await assert.rejects(
        action({ context: { ...context, structurePrompt: '' }, llmAgent: { async executePrompt() { return markdown; } } }),
        /document structure is required/,
    );
});

test('meeting-notes rejects LLM-authored SCRIPTA metadata', async () => {
    await assert.rejects(
        action({ context, llmAgent: { async executePrompt() { return `<!-- {"achilles-ide-document":{}} -->\n${markdown}`; } } }),
        /must not contain SCRIPTA metadata/,
    );
});

test('meeting-notes selects its tier only when it is available', async () => {
    let options = null;
    await action({
        context,
        llmAgent: {
            invokerStrategy: { listAvailableModels: () => ({ models: [{ name: 'meeting-notes' }] }) },
            async executePrompt(_prompt, value) {
                options = value;
                return markdown;
            },
        },
    });
    assert.deepEqual(options, { model: 'meeting-notes' });
});

test('meeting-notes uses the agent-configured Soul Gateway URL', async (t) => {
    const previous = process.env.SOUL_GATEWAY_URL;
    process.env.SOUL_GATEWAY_URL = 'http://gateway.test/services/soul-gateway/v1/chat/completions';
    t.after(() => {
        if (previous === undefined) delete process.env.SOUL_GATEWAY_URL;
        else process.env.SOUL_GATEWAY_URL = previous;
    });
    let options = null;
    await action({
        context,
        llmAgent: {
            async executePrompt(_prompt, value) {
                options = value;
                return markdown;
            },
        },
    });
    assert.deepEqual(options, {
        baseURL: 'http://gateway.test/services/soul-gateway/v1/chat/completions',
    });
});

test('meeting-notes requires the supported prompt API', async () => {
    await assert.rejects(
        action({ context, llmAgent: {} }),
        /requires an LLM agent/,
    );
});
