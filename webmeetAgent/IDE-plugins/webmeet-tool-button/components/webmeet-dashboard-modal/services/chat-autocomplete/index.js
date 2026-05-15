export { findTriggerAt } from './find-trigger.js';
export {
    escapeHtml,
    extractMentionTokenAt,
    findMentionRanges,
    normalizeMentionToken,
    renderComposerMentionOverlayHtml,
    renderMessageWithMentionHighlights
} from './mention-highlights.js';
export {
    WEBMEET_CANONICAL_AGENT_TAGS,
    applyAgentTagSelection,
    createAgentTagProvider
} from './agent-tag-provider.js';
export {
    applyWorkspacePathSelection,
    createWorkspacePathsProvider
} from './workspace-paths-provider.js';
export { createExplorerSearchAdapter } from './explorer-search-adapter.js';
export { createChatAutocomplete } from './chat-autocomplete.js';
