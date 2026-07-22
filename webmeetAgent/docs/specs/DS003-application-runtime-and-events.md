---
id: DS003
title: Application Runtime And Events
status: implemented
owner: webmeet-team
summary: Defines the WebMeet MCP tools, browser shells, event encoding, chat persistence, resources, Ploinky room-agent metadata, and avatar rendering boundaries.
---

# DS003 - Application Runtime And Events

## Introduction

`webmeetAgent` is a Ploinky application agent with a single MCP process. This specification defines its local runtime surfaces and the authoritative application flows that run through WebMeet rather than through LiveKit.

## Core Content

`scripts/startAgent.sh` starts:

| Process | Default port | Role |
| --- | --- | --- |
| `AgentServer` with `tools/webmeet_tool.mjs` | `7001` | MCP tool server used by Explorer, authenticated plugin calls, and public-protected room links. |

The manifest does not declare a WebMeet product HTTP API. Browser-facing WebMeet traffic enters through Explorer and the generic Ploinky MCP route:

| Surface | Owner | Contract |
| --- | --- | --- |
| `/<webmeetAgent>/roomLoader.html?roomId=<roomId>` | Ploinky core router | Direct room entry. Authenticated users keep their normal identity; unauthenticated visitors receive a public-protected room scope and see only the linked room. |
| Generic MCP route | Ploinky core router | Router-minted invocation identity and scopes are forwarded to WebMeet MCP tools. |

Direct container ports are implementation details. Ploinky core owns public-protected endpoint handling and whitelisting for WebMeet `roomLoader.html`, WebMeet plugin assets, shared UI components, and avatar assets. WebMeet must not add router-level guest asset bypasses or generated pages.

Explorer users and public-protected room visitors call MCP tools through the Explorer host and generic Ploinky MCP route. Tool groups include room listing/creation/join/leave, room events, participant avatar updates, room rename/archive, chat, AI agents, and resources. MCP tool invocations must be authorized by router-minted Router Request JWTs, except for JSON-RPC metadata methods such as initialize, tool listing, resource listing, cancellation notifications, and ping.

The browser intentionally talks to two systems:

| Browser sends | Receiver | Purpose |
| --- | --- | --- |
| Room list, create, rename, archive | `webmeetAgent` MCP | Application control plane and durable mutations. |
| Authenticated join and leave | `webmeetAgent` MCP | Authorize entry, update durable membership, and mint a LiveKit token. |
| Public-protected join, state, leave, chat, avatar | `webmeetAgent` MCP | RoomId-link flow authorized from the router-minted room scope. |
| Chat writes | `webmeetAgent` | Authoritative persistence in the encrypted meeting payload. |
| Blackboard final changes | `webmeetAgent` MCP | Authoritative final widget/object mutations, filtered room snapshots, undo/redo, and durable event emission. |
| Room-agent enable/disable/list | `webmeetAgent` MCP | Admin command path and participant-visible metadata for Ploinky-managed room agents persisted in the encrypted room payload. |
| Mic, camera, screen share, participant attributes, room hints | LiveKit | Live media and best-effort in-room realtime state. |

WebMeet event transport uses one encoded event string:

```text
room:type:base64url_payload
```

The `room` segment is the meeting id for meeting-scoped events and the workspace id for workspace-scoped events. The `type` segment is one of the central `WEBMEET_EVENT_TYPES` values. The payload is UTF-8 JSON encoded as base64url and must contain the event `id`, `createdAt`, and event-specific fields.

`webmeet-events.js` is the sole event contract module for store and browser UI code. It defines `WEBMEET_EVENT_TYPES`, payload validators, event builders/parsers, and persistence flags. Persistent event logs store encoded event strings directly in `.event` files. New callers must not write ad-hoc JSON event objects.

Persistent event types include room creation/rename/archive, participant membership changes, profile avatar updates, persisted chat notifications, Ploinky room-agent metadata, blackboard updates, and resource metadata events. Realtime-only event types include LiveKit data-channel chat delivery, live avatar projection, blackboard visibility, `/robo` command status, and avatar state requests. Realtime-only event types must not be written to durable meeting or workspace event logs.

Meeting mutation callbacks stage event intents via a `stageEvent(scope, type, data)` closure instead of calling `recordMeetingEvent` directly. Staged events are appended to the event log only after the encrypted payload save succeeds, ensuring the event log never references payload state that was not persisted. Meeting creation writes the meeting record before appending its creation event. Event append failures after a successful save are best-effort and do not roll back the mutation.

The authenticated dashboard shell owns room discovery, room management, profile settings, and admin actions. The public-protected room entry shell bootstraps exactly one room session from the `roomId` link and asks only unauthenticated visitors for a display name. Both shells share the common `WebMeetRoom` class for selected-room behavior. `WebMeetRoom` is the central orchestration boundary and must keep room identity (`meetingId`, `workspaceId`, `roomName`, `participantId`, `session`) plus lifecycle methods (`join`, `connectLiveKit`, `disconnectLiveKit`, `leave`, `refreshState`, `destroy`) separated from UI rendering. `WebMeetRoom` emits typed room events to the UI, including chat, participant, blackboard update, blackboard visibility, and blackboard command-status events. `WebMeetRoomLiveKit` owns browser LiveKit connection options and low-level room event hook binding. `WebMeetRoomEvents` owns encoded realtime publish/parse and event normalization. `WebMeetRoomState` owns serializable room state and must stay DOM-free. Dashboard controllers keep media capture controls, media track rendering, participant-card rendering, and UI actions.

New selected-room features should be added to `WebMeetRoom` or its explicit adapters first. Shell-specific code should only choose the session source and allowed controls. Authenticated sessions and public-protected guest sessions both use the generic MCP WebMeet tools; capabilities come from the join response.

Participant avatars are live rendering projections, not durable room profile state. Local authenticated participants may read their saved AxiFace profile avatar from Explorer's protected avatar settings service, and the current browser may apply a browser-scoped WebMeet avatar override. The dashboard must resolve the active local avatar before connecting LiveKit and before participant cards render: browser-local WebMeet override wins, then saved DPU profile avatar, then an explicit initial-letter fallback. Explorer profile responses with `source.kind="fallback"` or `source.kind="error"` are not saved avatars and must not be projected as generated AxiFace room avatars. Remote participant cards must not read another user's DPU My Space or protected avatar settings. Connected clients render the current LiveKit participant attribute/data-channel projection; unresolved workspace users and guests use only their live projection or deterministic local fallback. Participant cards must receive avatar updates through a dedicated avatar state channel, separate from the general media/card state channel. Media-only participant updates such as microphone publish, mute, unmute, audio subscription, and video track changes must not clear, recalculate, or rerender an already projected avatar; only a new avatar projection, avatar settings change, quick avatar action, participant disconnect, or explicit room UI reset may replace or remove that projected avatar.

WebMeet avatar override settings use the Explorer-hosted `explorer/shared/ui/avatar-settings-form` WebSkel component. The dashboard owns browser-local override storage, quick presets, and room projection publishing, while the shared component owns only source-mode rendering and draft normalization. WebMeet exposes the `generated` and `pack` source modes through the shared component and must not maintain separate handwritten avatar setting inputs for `generated`, `src`, and `packSrc`. Guest access to the shared component and avatar assets is provided by Ploinky core whitelisting on the Explorer shared route, not by WebMeet-specific asset routes.

Routine meeting-detail refreshes may update durable room data such as chat, resources, and agents, but they must not overwrite the live participant list or recalculate avatars from stale snapshot copies. The browser must not refresh meeting details from the backend when LiveKit reports `connected`; the initial connected-room roster comes from the LiveKit room snapshot and then changes only through LiveKit participant, track, active-speaker, attribute, and data-channel hooks. Workspace event polling is a lobby/workspace concern and must be stopped while the browser is inside an active LiveKit room; it may restart after leaving the room. Workspace roster events for the currently connected room must stay on the LiveKit-backed roster path and must not call the MCP meeting-list/meeting-get refresh path for that room. Existing participants must republish avatar projections when new participants connect, and avatar publish failures must not block joining.

Meeting chat has an authoritative persistence path and a best-effort realtime path. The durable chat write always goes through `webmeetAgent`; the browser or AI worker may then publish a reliable LiveKit data-channel payload of type `chat` so connected clients update quickly. LiveKit does not store WebMeet chat history. The MCP `webmeet_chat_send` schema accepts `authorId` and `authorName` as optional compatibility fields, but authenticated tool execution derives durable chat authorship from router auth and does not trust caller-supplied author fields. Guest chat writes derive `authorId` and `authorName` from the stored participant record, preventing callers from spoofing another participant's identity.

When the chat composer is empty, its primary action is browser-local push-to-talk for RoboTeam. During the shared authenticated/guest room connection path, WebMeet checks the browser microphone permission. A pending or unavailable Permissions API state is resolved with a temporary audio-only `getUserMedia` stream whose tracks are stopped immediately; an already granted state opens no stream, and refusal reports a warning without blocking room entry. Holding the microphone then uses `SpeechRecognition` or `webkitSpeechRecognition` with `navigator.language`, inserts `/robo ` immediately, and projects interim text into the existing composer. Releasing the pointer or keyboard control finalizes recognition and submits through the same `ChatComponent.sendChat()` and `webmeet_event_command` path as a typed command. Typing non-whitespace content restores the normal Send action. Pointer cancellation, empty recognition, permission denial, and unsupported browsers execute no command and surface a local explanatory error. This feature neither toggles the participant's LiveKit microphone nor sends audio to `webmeetAgent`, `webmeetStt`, or a new WebMeet HTTP/MCP endpoint; any speech processing is controlled by the browser implementation.

The room blackboard has the same authoritative control-plane rule. `webmeet_blackboard_get` is the read path and `webmeet_event_command` is the sole mutation path. The command accepts canonical JSON, deterministic `/event <allowlisted-action> [JSON object]`, and natural text from `/event` and `/robo`. Deterministic input is parsed locally; natural text uses a bounded per-round interpreter and returns events or an explicit natural-language semantic error. Browser and chat actions use the same canonical event-list contract. `create` is the only creation action; `add`, `lock`, and `unlock` are invalid. Commands never carry board preconditions or provenance. Events execute atomically under the room mutation lock, the board increments `revision` once, and serialized writes use last-edit-wins without `version_conflict`. The response projection is applied immediately, while `blackboard.updated` lets other clients ignore only older revisions. Blackboard visibility and `/robo` command status remain realtime-only.

Every `/event`, `/robo`, or UI event creates one durable chat audit entry with `kind: "event"`. The same entry transitions from `pending` to `success` or `error`; realtime delivery upserts by message id. Chat defaults to Normal and exposes one accessible Full switch. With the switch off, Normal shows participant discussion only; turning it on enables Full and preserves the combined chronological order of discussion and event audit entries. Full renders the safe semantic projection of each canonical event as `/event <action> [payload]`, without transport versions or opaque identifiers.

Ploinky room-agent metadata, blackboard state, and resource metadata are persisted by `webmeetAgent`. The current WebMeet MCP contract contains no separate meeting-derived content flows beyond chat, room resources, participant presence, room-agent metadata, and blackboard updates.

## Decisions & Questions

### Question #1: Why use MCP as the browser control plane?

Response:
Explorer plugin actions, direct room links, and public-protected guest sessions can all use the same Ploinky MCP route while preserving router-minted identity and scopes. Keeping WebMeet out of Ploinky server route generation avoids duplicated authorization surfaces and keeps domain authorization inside the agent tools.

### Question #2: Why encode events as `room:type:base64url_payload` instead of appending JSON files?

Response:
The encoded string is compact, easy to carry over SSE and LiveKit data channels, and enforces one parser/validator for both store and browser code. It prevents gradual divergence between filesystem events and realtime messages.

### Question #3: Why keep avatars out of durable meeting snapshots?

Response:
Profile avatars can come from protected Explorer user settings or browser-local overrides. Persisting them in meeting records would leak stale or cross-user presentation state. LiveKit participant attributes and reliable data-channel messages are the connected-room rendering channel, while the durable meeting store keeps membership and event metadata.

### Question #4: Why stage events instead of appending them directly inside mutators?

Response:
Most WebMeet events describe a payload mutation. Appending those events before the encrypted payload write succeeds can leave the event stream pointing at state that never became durable. Staging keeps event emission after the save boundary while allowing the mutation code to declare the intended event next to the state change.

### Question #5: Why keep optional chat author fields in the MCP schema?

Response:
Older callers may still include `authorId` and `authorName`, and keeping the fields optional avoids breaking those clients. The server-side tool derives the persisted author from verified router auth, so the compatibility fields do not grant spoofing authority.

## Conclusion

`webmeetAgent` remains a coherent application runtime while API, MCP, browser shells, events, chat, resources, Ploinky room-agent metadata, blackboard state, and avatars all preserve the correct persistence and route boundaries.
