import test from 'node:test';
import assert from 'node:assert/strict';

import { action as generateScriptaContent } from '../../skills/scripta-content/src/index.mjs';

test('SCRIPTA content generation uses strict structured output for documents and reformulations', async () => {
    const structuredCalls = [];
    const document = await generateScriptaContent({
        context: { task: 'create-scripta-document', template: 'vision', objective: 'A product' },
        llmAgent: {
            executeStructuredPrompt: async (_prompt, options) => {
                structuredCalls.push(options);
                return {
                    text: null,
                    visionParagraphs: [{ text: 'Users' }, { text: 'Value' }, { text: 'Delivery' }],
                    planParagraphs: null,
                    chapters: null,
                };
            },
        },
    });
    assert.equal(structuredCalls[0].schemaName, 'webmeet_scripta_content');
    assert.equal(structuredCalls[0].strict, true);
    assert.equal(structuredCalls[0].schema.additionalProperties, false);
    assert.equal(document.visionParagraphs.length, 3);
    assert.equal('text' in document, false);

    const promptCalls = [];
    const reformulation = await generateScriptaContent({
        context: { task: 'reformulate', paragraph: { text: 'Draft' }, command: 'Rewrite' },
        llmAgent: {
            executePrompt: async (_prompt, options) => {
                promptCalls.push(options);
                return { text: 'Rewritten', visionParagraphs: null, planParagraphs: null, chapters: null };
            },
        },
    });
    assert.equal(promptCalls[0].params.response_format.type, 'json_schema');
    assert.equal(promptCalls[0].params.response_format.json_schema.strict, true);
    assert.deepEqual(reformulation, { text: 'Rewritten' });
});
