function normalizedHeading(value) {
    return String(value || '').trim().replace(/[.:;]+$/g, '').toLocaleLowerCase();
}

function requestedChapterHeadings(structurePrompt) {
    const lines = String(structurePrompt || '').split(/\r?\n/)
        .map((line) => line.trim().replace(/^(?:[-*+]\s+|\d+[.)]\s+)/, ''))
        .filter(Boolean);
    if (lines.length > 1) {
        const headings = lines.filter((line) => (
            !/\b(?:create|title|followed|these chapters|chapters? in|sections? in)\b/i.test(line)
            && !/^(?:chapters?|sections?)\s*:?$/i.test(line)
        ));
        if (headings.length) return headings;
    }
    const namedChapter = lines[0]?.match(/\bchapter\s+named\s+(.+?)[.!]?$/i)?.[1];
    if (namedChapter) return [namedChapter];
    const chapterList = lines[0]?.match(/\bchapters?\s*:\s*(.+)$/i)?.[1];
    return chapterList ? chapterList.split(/\s*;\s*/).filter(Boolean) : [];
}

function validateDocumentStructure(markdown, structurePrompt) {
    const lines = markdown.split(/\r?\n/);
    const firstContentLine = lines.find((line) => line.trim());
    const h1Headings = lines.filter((line) => /^#(?!#)\s+\S/.test(line.trim()));
    if (!/^#(?!#)\s+\S/.test(String(firstContentLine || '').trim()) || h1Headings.length !== 1) {
        throw new Error('Meeting-notes Markdown must begin with a document title and contain exactly one H1.');
    }
    const actualChapters = lines
        .map((line) => line.trim().match(/^##(?!#)\s+(.+)$/)?.[1])
        .filter(Boolean);
    if (!actualChapters.length) throw new Error('Meeting-notes Markdown requires at least one H2 chapter.');
    const requestedChapters = requestedChapterHeadings(structurePrompt);
    if (requestedChapters.length && (
        requestedChapters.length !== actualChapters.length
        || requestedChapters.some((heading, index) => (
            normalizedHeading(heading) !== normalizedHeading(actualChapters[index])
        ))
    )) {
        throw new Error('Meeting-notes Markdown does not match the configured chapter structure.');
    }
}

function markdownResult(response, input) {
    const value = response?.result ?? response?.content ?? response;
    const markdown = String(value || '').trim()
        .replace(/^```(?:markdown|md)?\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
    if (!markdown) throw new Error('Meeting-notes analysis returned an empty Markdown document.');
    if (markdown.length > 60_000) throw new Error('Meeting-notes analysis returned an oversized Markdown document.');
    if (/<!--[\s\S]*?achilles-ide-/i.test(markdown)) {
        throw new Error('Meeting-notes Markdown must not contain SCRIPTA metadata.');
    }
    validateDocumentStructure(markdown, input.structurePrompt);
    return markdown;
}

function meetingInstruction(input) {
    const structurePrompt = String(input.structurePrompt || '').trim();
    if (!structurePrompt) throw new Error('Meeting-notes document structure is required.');
    return [
        'Return one COMPLETE replacement Markdown document for the meeting, and return Markdown only: no JSON, no explanation, and no fenced code block.',
        'The Markdown is the document source of truth. Reconcile all supplied discussion, not merely the latest segments. Later corrections, decisions, cancellations, owners, and deadlines replace superseded notes.',
        'Use exactly one H1 title. Render the chapters requested by the configured document structure as H2 headings in the requested order.',
        `Configured document structure:\n${structurePrompt}`,
        'Use concise Markdown lists in sections. Attribute every substantive list item to its speaker(s), for example `- **Ana:** proposed ...`. Do not invent speakers, consensus, owners, statuses, deadlines, or decisions. Include those only when explicitly stated.',
        'Use concrete vocabulary from every substantive supplied topic. Remove duplicates; a proposal that becomes a decision belongs in Decisions, and a question belongs only in Questions.',
        'Do not emit HTML comments, SCRIPTA ids, document metadata, JSON, or implementation instructions. The document system owns those details.',
        `Participants: ${JSON.stringify(input.participants || [])}`,
        `Current Markdown document: ${String(input.currentMarkdown || '')}`,
        `Cumulative discussion memory through segment ${Number(input.compactedSegmentCount || 0)}: ${String(input.discussionMemory || '')}`,
        `Complete uncompacted chronological journal: ${JSON.stringify(input.journal || [])}`,
        `New segment ids included in this revision: ${JSON.stringify(input.newSegmentIds || [])}`,
    ].join('\n');
}

function meetingNotesModel(llmAgent) {
    const models = llmAgent?.invokerStrategy?.listAvailableModels?.().models;
    return Array.isArray(models) && models.some((entry) => String(entry?.name || '') === 'meeting-notes')
        ? 'meeting-notes'
        : null;
}

function meetingNotesInvocationOptions(llmAgent) {
    const configuredGatewayUrl = String(process.env.SOUL_GATEWAY_URL || '').trim();
    return {
        ...(meetingNotesModel(llmAgent) ? { model: 'meeting-notes' } : {}),
        ...(configuredGatewayUrl ? { baseURL: configuredGatewayUrl } : {}),
    };
}

export async function action({ promptText, llmAgent, context }) {
    if (!llmAgent?.executePrompt) {
        throw new Error('Meeting-notes analysis requires an LLM agent.');
    }
    const input = context && typeof context === 'object' ? context : JSON.parse(String(promptText || '{}'));
    const instruction = meetingInstruction(input);
    const options = meetingNotesInvocationOptions(llmAgent);
    return markdownResult(await llmAgent.executePrompt(instruction, options), input);
}

export default action;
