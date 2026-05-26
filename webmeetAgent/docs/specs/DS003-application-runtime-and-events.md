---
id: DS003
title: Application Runtime And Events
status: implemented
owner: webmeet-team
summary: Defines the WebMeet API, MCP tools, browser shells, event encoding, chat/transcript/artifact persistence, and avatar rendering boundaries.
---

# DS003 - Application Runtime And Events

## Introduction

`webmeetAgent` is a Ploinky application agent with three Node processes in one container. This specification defines its local runtime surfaces and the authoritative application flows that run through WebMeet rather than through LiveKit.

## Core Content

`scripts/startAgent.sh` starts:

| Process | Default port | Role |
| --- | --- | --- |
| `server/webmeet-api.mjs` | `8791` | Local REST API used by the proxy and internal worker flows. |
| `AgentServer` with `tools/webmeet_tool.mjs` | `7001` | MCP tool server used by Explorer and authenticated plugin calls. |
| `server/webmeet-public-proxy.mjs` | `7000` | Manifest-facing HTTP service proxy for protected and guest routes. |

The manifest declares two router-facing HTTP service prefixes for the same internal `/api/` surface:

| External prefix | Auth mode | Contract |
| --- | --- | --- |
| `/services/webmeet/` | `protected` | Authenticated Explorer/API traffic. The proxy verifies the router invocation and applies verified auth info before forwarding. |
| `/public-services/webmeet/` | `guest`, `forceGuest: true` | Invite-scoped guest traffic. The proxy verifies a router-issued guest invocation and forwards only guest-allowed routes. |

Browser-facing WebMeet traffic must enter through the Ploinky router or through authenticated Explorer MCP calls. Direct container ports are implementation details. The public proxy may serve guest page assets, WebMeet plugin assets needed by the guest shell, and guest-scoped AxiFace assets, but it must keep public static roots constrained to known plugin, vendor, WebSkel, and shared-style paths.

Authenticated Explorer users normally call MCP tools through the Explorer host. Tool groups include workspace listing/creation, meeting listing/creation/join/leave/presence, meeting and workspace events, participant avatar updates, room rename/delete, chat, transcript, AI agents, recording, artifacts, tasks, and decisions. MCP tool invocations must be signed by router-minted invocation JWTs, except for JSON-RPC metadata methods such as initialize, tool listing, resource listing, cancellation notifications, and ping.

The browser intentionally talks to two systems:

| Browser sends | Receiver | Purpose |
| --- | --- | --- |
| Workspace list, room list, create, rename, delete | `webmeetAgent` MCP/API | Application control plane and durable mutations. |
| Authenticated join, leave, presence | `webmeetAgent` | Authorize entry, update durable presence, and mint a LiveKit token. |
| Guest join, state, leave, presence, chat, avatar | `webmeetAgent` public proxy/API | Public invite flow with guest-token validation. |
| Chat and transcript writes | `webmeetAgent` | Authoritative persistence in the encrypted meeting payload. |
| Recording start/stop | `webmeetAgent` | Admin command path that calls LiveKit Egress APIs and persists metadata. |
| AI attach/detach | `webmeetAgent` | Admin command path that creates/deletes explicit LiveKit dispatches. |
| Mic, camera, screen share, participant attributes, room hints | LiveKit | Live media and best-effort in-room realtime state. |

WebMeet event transport uses one encoded event string:

```text
room:type:base64url_payload
```

The `room` segment is the meeting id for meeting-scoped events and the workspace id for workspace-scoped events. The `type` segment is one of the central `WEBMEET_EVENT_TYPES` values. The payload is UTF-8 JSON encoded as base64url and must contain the event `id`, `createdAt`, and event-specific fields.

`webmeet-events.js` is the sole event contract module for store and browser UI code. It defines `WEBMEET_EVENT_TYPES`, payload validators, event builders/parsers, and persistence flags. Persistent event logs store encoded event strings directly in `.event` files. New callers must not write ad-hoc JSON event objects.

Persistent event types include room creation/rename, participant membership changes, profile avatar updates, persisted chat/transcript notifications, AI dispatch metadata, recording events, and artifact creation. Realtime-only event types include LiveKit data-channel chat delivery, live avatar projection, and avatar state requests. Realtime-only event types must not be written to durable meeting or workspace event logs.

Meeting mutation callbacks stage event intents via a `stageEvent(scope, type, data)` closure instead of calling `recordMeetingEvent` directly. Staged events are appended to the event log only after the encrypted payload save succeeds, ensuring the event log never references state that was not persisted. Event append failures after a successful save are best-effort and do not roll back the mutation.

The authenticated dashboard shell owns workspace discovery, room management, profile settings, and admin actions. The guest shell owns invite-token entry and bootstraps exactly one room session from the public link. Both shells share the common `WebMeetRoom` class for selected-room behavior. `WebMeetRoom` is the central orchestration boundary and must keep room identity (`meetingId`, `workspaceId`, `roomName`, `participantId`, `session`) plus lifecycle methods (`join`, `connectLiveKit`, `disconnectLiveKit`, `leave`, `refreshState`, `destroy`) separated from UI rendering. `WebMeetRoom` emits typed room events to the UI (`room:joined`, `room:left`, `room:participant-joined`, `room:participant-left`, `room:chat`, `room:transcript`, `room:avatar-projected`, `room:agent-attached`, `room:recording-started`). `WebMeetRoomLiveKit` owns browser LiveKit connection options and low-level room event hook binding. `WebMeetRoomEvents` owns encoded realtime publish/parse and event normalization. `WebMeetRoomState` owns serializable room state and must stay DOM-free. Dashboard controllers keep media capture controls, media track rendering, participant-card rendering, and UI actions. The future speech/text Audio Agent has no browser room implementation until its TTS/STT contract is specified.

New selected-room features should be added to `WebMeetRoom` or its explicit adapters first. Shell-specific code should only choose the session source and allowed controls. Authenticated sessions use protected MCP-compatible WebMeet tools; guest sessions use only scoped public guest endpoints.

Participant avatars are live rendering projections, not durable room profile state. Local authenticated participants may read their saved AxiFace profile avatar from Explorer's protected avatar settings service, and the current browser may apply a browser-scoped WebMeet avatar override. Remote participant cards must not read another user's DPU My Space or protected avatar settings. Connected clients render the current LiveKit participant attribute/data-channel projection; unresolved workspace users and guests fall back to a first-letter avatar. Media-only participant updates such as microphone publish, mute, unmute, audio subscription, and video track changes must not clear an already projected avatar; only a new avatar projection, participant disconnect, or explicit room UI reset may replace or remove that projected avatar.

Routine meeting-detail refreshes may update durable room data such as chat, transcript, artifacts, tasks, decisions, recordings, and agents, but they must not overwrite the live participant list or recalculate avatars from stale snapshot copies. Existing participants must republish avatar projections when new participants connect, and avatar publish failures must not block joining.

Meeting chat has an authoritative persistence path and a best-effort realtime path. The durable chat write always goes through `webmeetAgent`; the browser or AI worker may then publish a reliable LiveKit data-channel payload of type `chat` so connected clients update quickly. LiveKit does not store WebMeet chat history. The MCP `webmeet_chat_send` tool accepts `authorId` and `authorName` as optional fields; when provided by authenticated callers they are stored as-is (the caller is identity-verified via router auth). Guest chat writes derive `authorId` and `authorName` from the stored participant record, preventing callers from spoofing another participant's identity.

Transcripts, artifacts, tasks, decisions, recording metadata, and AI dispatch metadata are persisted by `webmeetAgent`. Internal scribe transcript writes may use the `/internal/meetings/:meetingId/transcript` API only with `WEBMEET_AGENT_INTERNAL_TOKEN`, derived from the shared WebMeet agent-secret identity.

## Decisions & Questions

### Question #1: Why have both HTTP API and MCP tools?

Response:
Explorer plugin actions naturally use the existing MCP tool channel for authenticated agent calls, while guest invite pages need a narrow browser HTTP surface that does not grant general Explorer or MCP access. Keeping both surfaces behind the Ploinky router lets each caller use the correct transport without bypassing secure-wire invocation.

### Question #2: Why encode events as `room:type:base64url_payload` instead of appending JSON files?

Response:
The encoded string is compact, easy to carry over SSE and LiveKit data channels, and enforces one parser/validator for both store and browser code. It prevents gradual divergence between filesystem events and realtime messages.

### Question #3: Why keep avatars out of durable meeting snapshots?

Response:
Profile avatars can come from protected Explorer user settings or browser-local overrides. Persisting them in meeting records would leak stale or cross-user presentation state. LiveKit participant attributes and reliable data-channel messages are the connected-room rendering channel, while the durable meeting store keeps membership and event metadata.

## Conclusion

`webmeetAgent` remains a coherent application runtime while API, MCP, browser shells, events, chat, transcripts, artifacts, and avatars all preserve the correct persistence and route boundaries.
