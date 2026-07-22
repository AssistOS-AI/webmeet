---
id: DS009
title: Blackboard Agentic Diagrams
status: implemented
owner: webmeet-team
summary: Defines the revision-only Blackboard model, canonical multi-event commands, semantic focus, attached diagrams, explicit semantic errors, and transient RoboTeam command status.
---

# DS009 - Blackboard Agentic Diagrams

## Introduction

The WebMeet Blackboard is the authoritative home for widgets, geometry, groups, attached connections, shared semantic focus, and bounded history. Room infrastructure supplies authorization, serialized persistence, and realtime transport but does not duplicate this functional state.

## Core Content

The persisted board contains `boardId`, monotonically increasing `revision`, widgets, history, and `interactionContext`. The public projection contains `boardId`, `revision`, filtered widgets, and `interactionContext`. Revisions order realtime projections. They are never client preconditions: WebMeet uses serialized last-edit-wins writes, does not accept `expectedBoardVersion`, does not emit `version_conflict`, and ignores realtime projections older than the currently applied revision.

`webmeet_event_command` accepts canonical JSON, deterministic `/event <action> [JSON object]`, and natural `/event` or `/robo` text. Natural input creates an isolated `MainAgent` for one bounded round with internal skills disabled and only the `blackboard-event` skill available. Its context contains the instruction, logical content bounds, safe widget semantics and capabilities, transient global widget ordinals, shared focus, and last affected widget ids. It excludes viewport state, room revision, participant-private data, paths, editor URLs, audit identifiers, and transport identifiers.

The canonical public actions are `create`, `update`, `delete`, `group`, `ungroup`, `clear`, `undo`, `redo`, `show`, `hide`, and declared widget-domain actions. `focus` is internal and UI-only. `add`, `lock`, and `unlock` are invalid. Events never contain server-generated widget ids, event ids, command ids, revisions, participant ids, or provenance. A multi-event result uses `{events:[...]}`; create events may declare a command-local `ref`, which later ordered targets and connection endpoints may resolve. Duplicate and forward references fail the entire command.

One command is validated and applied on one working board, persisted only when every event succeeds, recorded as one history entry, and undone as one unit. The server generates ids, resolves references, attaches provenance, updates shared focus, increments revision once, saves, and publishes `blackboard.updated`. RoboTeam mutations use `agent_robo_team` as technical author and retain the authorized participant only as private provenance. UI mutations use the authorized participant and `source: "ui"`; caller-supplied authorship is rejected.

Visible widget geometry defines logical content bounds. An empty board uses `0,0,1200,800`; generated layouts use a default 40-pixel gap and never depend on browser viewport, zoom, or scrolling. Free lines store endpoints. Attached line widgets store `properties.connection.from/to`, where each endpoint identifies a widget and one of `left`, `right`, `top`, `bottom`, or `center`. The renderer derives endpoints from current target geometry, so connections follow moves and resize; deleting either endpoint removes dependent connections.

Widgets share a non-nested `groupId`. Moving one member moves every member by the same delta, resizing affects only the selected member, deletion preserves remaining members, `ungroup` clears the id on every member, and singleton groups dissolve. Shape text uses `properties.label` and is centered in the shape SVG rather than represented by a second text widget.

`interactionContext` stores `focusedWidgetId`, `lastAffectedWidgetIds`, `updatedBy`, and `updatedAt`. The latest create, manual selection, move, resize, or edit updates global focus; plural follow-up language uses the last affected ids. Missing focused widgets are cleared. Focus changes do not create undo steps.

The interpreter returns either `{events:[...]}` or `{error:{code,message}}`. Ambiguous or unsafe intent returns a precise natural-language error in the instruction language and executes no events. The audit entry transitions directly from `pending` to `success` or `error`; no clarification state or popup exists.

As soon as the chat composer starts with `/robo`, the local browser shows deterministic ordinal badges over the projected widgets, allowing references such as “line 3”. The badges remain active during execution, disappear when the prefix is removed or the command reaches a terminal result, and are transient DOM overlays that never become widget properties or history. A realtime-only `blackboard.command_status` event lets all participants see who is editing after submission. Terminal success remains visible for four seconds, terminal errors for ten seconds, and stale active status expires after the interpreter timeout plus fifteen seconds.

## Decisions & Questions

### Question #1: Why is revision not an optimistic concurrency precondition?

Response:
The room mutation lock already supplies a deterministic server order. Revision is required only to discard stale realtime projections; making it a client precondition would reject valid last-edit-wins collaboration and require unnecessary read/retry cycles.

### Question #2: Why is focus shared board state?

Response:
Follow-up commands such as “move it” and “align them” must resolve identically for every participant. Persisting focus and last affected targets on the board provides that deterministic semantic context without relying on participant viewport or DOM selection.

## Conclusion

Blackboard commands remain deterministic and secure while server order defines last-edit-wins behavior, canonical event lists execute atomically, ambiguous instructions fail without mutation, and collaboration status stays transient.
