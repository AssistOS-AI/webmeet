---
id: DS002
title: Room State And Access
status: implemented
owner: webmeet-team
summary: Defines WebMeet meeting records, team and guest room behavior, durable storage, encryption, and invite-scoped access checks.
---

# DS002 - Room State And Access

## Introduction

The WebMeet UI normally says "room". The backend stores a durable "meeting" record and derives a LiveKit room name from that record. This specification defines the application data model and the access contract for authenticated team rooms and public guest meetings.

## Core Content

A WebMeet room is two related objects:

| Concept | Meaning | Stored where |
| --- | --- | --- |
| WebMeet meeting record | Durable application object with a `meeting_<uuid>` id, workspace id, title, `roomType`, derived `roomName`, optional `guestToken`, status, expiration, wrapped data-encryption key, and encrypted payload. | `/data/meetings/*.json`, backed by `.ploinky/data/webmeetAgent/data/meetings/*.json`. |
| LiveKit room | Media room name derived as `${WEBMEET_ROOM_PREFIX || "webmeet"}-${workspaceId}-${meetingId}`, sanitized and capped for LiveKit. | LiveKit runtime state, coordinated through Redis while active. |

The encrypted WebMeet payload contains members, chat messages, transcript segments, recordings, artifacts, tasks, decisions, AI agent metadata, and event snapshots. Meeting payloads use AES-256-GCM with per-meeting data keys wrapped by `PLOINKY_WEBMEET_MASTER_KEY`. That key is an agent-scoped generated secret declared with `generatedSecret: true`. The store does not support automatic legacy meeting-key fallback.

WebMeet store operations are asynchronous. Meeting records, workspace records, and event logs are read and written through promise-based filesystem APIs. Record writes keep the temp-file plus rename pattern for atomic replacement. Meeting payload writes, meeting deletion, expired-meeting purge, and LiveKit participant reconciliation are serialized in two layers: an in-process per-meeting promise queue prevents interleaving within one Node process, and a cross-process filesystem lock (`<meetingLocksDir>/<meetingId>.lock`) prevents interleaving across concurrent MCP tool subprocesses. The lock is acquired by atomically creating the lock file with `open(..., "wx")`, writing pid, hostname, timestamp, meeting id, and a random token into the file, retrying with jittered backoff, and cleaning up stale locks only after the lock file itself is older than the configured stale TTL (`WEBMEET_LOCK_TIMEOUT_MS`, `WEBMEET_LOCK_STALE_TTL_MS`) and the recorded same-host owner process is not alive. Release verifies token ownership before removing the lock file.

`webmeetAgent` supports two room types:

| `roomType` | UI meaning | Access model |
| --- | --- | --- |
| `team` | Normal workspace room. | Authenticated Explorer users enter through protected MCP/API paths. |
| `guest` | Public meeting. | An admin-created invite URL carries `room=<meetingId>&token=<guestToken>`. The guest HTTP service validates router guest identity and the stored meeting token before issuing a LiveKit participant JWT. |

Admin users create, rename, delete, expose guest links, start and stop recordings, attach and detach AI agents, and view administrative meeting data. Normal authenticated users can see and join active workspace rooms returned for the current workspace. Guest users only receive the public-service actions required for the invite room they joined.

Guest room creation must store a random `guestToken` in the meeting metadata. The public URL has the form `/public-services/webmeet/guest?room=<meetingId>&token=<guestToken>`. Possession of the token is necessary but not sufficient: the request must also arrive through the Ploinky manifest-declared guest HTTP service, and `webmeet-public-proxy.mjs` must verify the router-issued `__http_service__` invocation token with a guest role before serving guest pages or forwarding guest APIs.

The guest public API is intentionally narrow. It may expose guest join, room state for the joined guest identity, leave, chat, avatar publication for that participant, and transcript download with guest token plus participant id. It must not expose Explorer, generic MCP access, protected WebMeet APIs, room management, recording controls, AI controls, presence ping endpoints, or administrative artifacts. The guest room-state response (`getGuestMeetingDetails`) returns exactly `{meeting, participants, chat}`. It must not include transcript segments, artifacts, recordings, tasks, decisions, or agent dispatch metadata.

After join, WebMeet keeps two participant views:

- Durable WebMeet membership in the encrypted meeting payload, updated by join, explicit leave, LiveKit reconciliation, and stale cleanup. Browser room UI must not drive the connected participant list through presence timers; the connected roster is LiveKit state.
- Live room presence in LiveKit, surfaced through participant, publication, subscription, mute, active-speaker, data-channel, participant-attribute, and disconnect events.

A participant that completed the WebMeet join step but has not appeared in LiveKit yet must remain in durable membership until LiveKit exposes that identity or normal presence TTL cleanup removes it. A room-detail reconciliation must not drop a pending member only because another viewer refreshes before the media-plane connection finishes.

When a local participant connects to LiveKit, WebMeet must not publish a provisional room avatar and then a second canonical avatar for the same join. Initial join uses the already resolved effective avatar (WebMeet override first, then saved profile avatar, then fallback) and skips the generic reconnect republish path once, so participant cards render only the final resolved avatar unless the user explicitly changes avatar settings or quick actions.

Recording files are not part of the encrypted meeting JSON. MP4 outputs live under `/data/recordings/<meetingId>/<recordingId>.mp4`, backed by `.ploinky/data/webmeet/recordings`. `webmeetAgent` persists recording metadata and artifact entries in the encrypted payload, while LiveKit Egress writes the media file.

Redis must never be treated as the WebMeet room directory. Redis may contain LiveKit node, room, participant, routing, and egress coordination state, but WebMeet room lists, invite tokens, chat history, transcripts, artifacts, and recording metadata are owned by the WebMeet store.

## Decisions & Questions

### Question #1: Why store a WebMeet meeting separately from a LiveKit room?

Response:
LiveKit rooms are live media sessions. They are not a durable application database and do not carry WebMeet-specific authorization, encrypted chat, guest invite tokens, transcripts, artifacts, or workspace room lists. The WebMeet meeting record preserves those product contracts independently of media-session lifetime.

### Question #2: Why does guest access require both router guest identity and `guestToken`?

Response:
Router guest identity proves that the request came through the declared guest HTTP service and was signed by Ploinky. The WebMeet token proves that the caller has the specific meeting invite. Either check by itself is too broad: router guest identity alone would apply to the whole service route, while a token alone would be unsafe if sent directly to an internal port.

### Question #3: Why are recordings outside payload encryption?

Response:
Recordings are large binary Egress outputs written through the shared recording volume. The encrypted meeting payload stores metadata and artifact references, not the MP4 bytes. Access control for the file depends on workspace filesystem/container exposure and WebMeet artifact policy.

### Question #4: Why is `PLOINKY_WEBMEET_MASTER_KEY` generated by Ploinky?

Response:
`PLOINKY_WEBMEET_MASTER_KEY` protects encrypted meeting payloads and therefore must be stable for the workspace. WebMeet declares it with `generatedSecret: true` so Ploinky derives the value deterministically from the agent identity instead of relying on a manually configured or randomly persisted key.

### Question #5: Why use a lock file rather than a lock directory with an owner file?

Response:
The previous lock-directory design created the directory before writing `owner.json`, so a competing process could observe a fresh but ownerless lock and incorrectly remove it as stale. A single atomically-created lock file removes that owner-write window. Stale cleanup still waits for file age to exceed the TTL and refuses to clean up a same-host owner process that is still alive.

## Conclusion

WebMeet room state remains coherent while `webmeetAgent` owns durable meeting records, encrypts payload data, validates team and guest access through the correct route shape, and treats LiveKit and Redis as media/runtime services rather than application storage.
