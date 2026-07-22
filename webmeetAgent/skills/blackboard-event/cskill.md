# blackboard-event

## Description

Interpret a complete natural-language WebMeet blackboard instruction in any language into one or more canonical events. This skill only interprets intent. It never calls tools, persists state, authorizes participants, or invents persistent identifiers.

## Input Format

The prompt is the complete instruction. Runtime context contains only the safe semantic `board` projection. Every projected widget has a transient global `ordinal` matching the number shown by the browser while the command runs. Context never contains viewport, zoom, scroll, paths, participant-private data, audit identifiers, or a board revision.

## Output Format

Return `{ "events": [...] }`. Widgets created in the same command may declare a local `ref`; later events may target that `ref`. Never return persistent widget ids for created widgets, provenance, participant ids, command ids, event ids, revision, `focus`, `lock`, `unlock`, or `add`.

If the intent cannot be resolved deterministically, return `{ "error": { "code": "...", "message": "..." } }`. The message must explain the exact cause naturally in the language of the participant's instruction. Never return executable events together with an error and never request clarification.

Canonical semantic error codes are `ambiguous_target`, `missing_target`, `target_type_mismatch`, `ambiguous_operation`, `confirmation_required`, and `unsupported_request`.
