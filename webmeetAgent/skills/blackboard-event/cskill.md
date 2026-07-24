# blackboard-event

## Description

Interpret a complete natural-language WebMeet blackboard instruction in any language into one or more canonical events. This skill only interprets intent. It never calls tools, persists state, authorizes participants, or invents persistent identifiers.

## Input Format

The prompt is the complete instruction. Runtime context contains only the safe semantic `board` projection. Every projected widget has a transient global `ordinal` matching the number shown by the browser while the command runs. In compact or speech-transcribed commands, a spoken or numeric integer immediately after a widget kind is interpreted as that widget's ordinal when it matches an existing widget, even if punctuation or words such as `by` are omitted. If no ordinal identifies a target, a compatible focused element is used. A SCRIPTA widget additionally exposes a safe document outline and its active chapter/paragraph focus, without paragraph content or participant-private data. Context never contains viewport, zoom, scroll, paths, participant-private data, audit identifiers, or a board revision.

## Output Format

Return `{ "events": [...] }`. Widgets created in the same command may declare a local `ref`; later events may target that `ref`. Never return persistent widget ids for created widgets, provenance, participant ids, command ids, event ids, revision, `focus`, `lock`, `unlock`, or `add`.

Widgets sharing a non-empty `groupId` are one rigid block. Existing groups are targeted with `{ "type": "group", "groupId": "..." }`; their canonical update uses `payload.patch.transform` with `translation`, `resize`, or `rotationDelta`. Group deletion removes every member, while `ungroup` preserves current geometry. A group id must always come from context.

Create a group only when every selected widget exposes `capabilities.groupable: true`. Interactive widgets (`poll`, `bullets`, `embed`, and `scripta-document`) are complex standalone widgets and must never be grouped.

If the intent cannot be resolved deterministically, return `{ "error": { "code": "...", "message": "..." } }`. The message must explain the exact cause naturally in the language of the participant's instruction. Never return executable events together with an error and never request clarification.

Canonical semantic error codes are `ambiguous_target`, `missing_target`, `target_type_mismatch`, `ambiguous_operation`, `confirmation_required`, and `unsupported_request`.
