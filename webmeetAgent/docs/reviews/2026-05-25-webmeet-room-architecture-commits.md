# WebMeet Room Architecture Commit Review

Review date: 2026-05-25

Reviewed commits:

- `0aa23631c6dabd1af511801d443fe7a7531fbbfa` by `adiganga2002 <adiganga2002@yahoo.com>`: `Refactor WebMeet dashboard to new room runtime architecture`
- `d65a4d24aff6991013aa179d952f6b2fbae2f77a` by `adiganga2002 <adiganga2002@yahoo.com>`: `Add WebMeetRoomLiveKit class for LiveKit integration`

The local tree at `HEAD` still matches the post-`d65a4d2` WebMeet agent implementation for the reviewed files, so this review uses the current `webmeetAgent` code as the reviewed end state.

## Findings First

### P1: the per-room lock is not sound across WebMeet's real mutation topology

`webmeetStore.mjs` now has a per-`meetingId` promise queue (`meetingMutationQueues`) and all `mutateMeeting()` callers inside one Node process serialize through it (`webmeetAgent/lib/webmeetStore.mjs:35`, `webmeetAgent/lib/webmeetStore.mjs:284`). That is a good local fix, but the MCP tool runner starts a new Node process for every tool call (`webmeetAgent/tools/webmeet_tool.sh:4`), and the HTTP API is another process. Each process has its own module-scoped `meetingMutationQueues`.

The result is that atomic temp-file plus rename prevents torn or truncated JSON reads (`webmeetAgent/lib/webmeetStore.mjs:192`), but it does not prevent lost updates. Two separate processes can both read the same encrypted meeting payload, mutate different arrays, and then each rename a full record over the other. High-risk examples are simultaneous chat, presence cleanup, agent attach/detach, transcript append, and recording updates.

The docs accurately say mutations are serialized "inside the agent process" (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:26`), but the architecture still has multiple writing processes. A sound lock needs a cross-process mechanism, such as a lockfile opened with exclusive create, `flock`, SQLite, or forcing all MCP mutations through one long-lived WebMeet API writer.

### P2: event logs can diverge from the meeting payload

Several mutators append persistent events from inside the `mutateMeeting()` callback before `saveMeetingRecord()` writes the encrypted payload. For example, chat push happens before `recordMeetingEvent()`, and the save occurs after the callback returns (`webmeetAgent/lib/webmeetStore.mjs:1759`, `webmeetAgent/lib/webmeetStore.mjs:1772`, `webmeetAgent/lib/webmeetStore.mjs:1773`, `webmeetAgent/lib/webmeetStore.mjs:291`). If a save fails, or if another process overwrites the record afterward, the `.event` log can claim an update happened while the durable room payload does not contain that update.

This matters because the UI uses persistent events to trigger refreshes, while authoritative room history comes from the encrypted payload. The current design may occasionally notify a chat/artifact/recording change that cannot be found after refresh.

### P2: guest room state currently returns more than the guest access spec says it should

`DS002` says the guest public API is intentionally narrow and "must not expose ... administrative artifacts" (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:39`). The implementation of `getGuestMeetingDetails()` returns `transcript`, `artifacts`, `recordings`, `tasks`, `decisions`, and `agents` after guest-token and participant validation (`webmeetAgent/lib/webmeetStore.mjs:1468`, `webmeetAgent/lib/webmeetStore.mjs:1484`).

Some of this may be intentional room-state sharing, and the dashboard does not visibly render all of it in the main guest UI. Still, as written, the public guest state endpoint exposes administrative-ish arrays that normal authenticated non-admin users do not load. This should be resolved by either narrowing the endpoint or explicitly changing the spec to say which guest-visible room artifacts are public.

### P3: the new room boundary is real, but not yet the only selected-room owner

The commits introduce a much clearer `WebMeetRoom` concept and adapter set. The dashboard now instantiates `WebMeetRoomLiveKit` and `WebMeetRoom` (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js:123`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js:133`). However, `WebMeetRoom` is currently constructed with `livekit: null`, so it falls back to controller methods `connectRoom()` and `disconnectRoom()` (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js:133`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.js:145`).

The large LiveKit hook body still lives in `room-session-methods.js` and still owns track rendering, participant sync, data-channel dispatch, participant attributes, and media state (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js:316`). That is not a regression; the new split is better. But the architecture is not yet "Room owns all selected-room runtime" in the strong sense. It is "Room owns lifecycle/API/event/state contracts, while dashboard controllers still own media and DOM projection."

### P3: `webmeet_chat_send` schema still asks for fields the tool ignores

The chat-send MCP schema still marks `authorId` and `authorName` as required (`webmeetAgent/mcp-config.json:209`). The implementation derives the author from router-provided auth info and rejects unauthenticated user chat (`webmeetAgent/tools/webmeet_tool.mjs:151`, `webmeetAgent/tools/webmeet_tool.mjs:243`). That security decision is good, but the schema is now misleading and can force clients to send meaningless values.

## What Decisions Were Made

### 1. Split "room" into durable WebMeet state plus LiveKit runtime

The docs now define a room as two related objects:

- A durable WebMeet meeting record stored in `/data/meetings/*.json`.
- A LiveKit room used for active media runtime state (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:17`).

This is the most important architectural decision. LiveKit is treated as the SFU and realtime media/data-channel layer, not as the WebMeet database. The durable record owns workspace identity, title, room type, guest token, status, expiration, encryption metadata, and encrypted payload (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:21`). LiveKit owns the active room/session plane (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:22`).

Why this improves the architecture:

- WebMeet can retain chat, transcript, artifacts, invite tokens, recording metadata, and AI dispatch metadata across LiveKit room lifetime.
- The product can distinguish app authorization from media authorization.
- Redis and LiveKit can restart or expire runtime rooms without becoming the durable source of truth.

### 2. Make `WebMeetRoom` the browser selected-room orchestration boundary

Commit `0aa2363` deletes the older `room-runtime` service and introduces:

- `services/room/webmeet-room.js`
- `services/room/webmeet-room-api.js`
- `services/room/webmeet-room-events.js`
- `services/room/webmeet-room-state.js`
- `tests/unit/webmeet-room.test.mjs`

`DS003` now says `WebMeetRoom` owns selected-room identity and lifecycle methods, emits typed room events, and keeps those concerns separate from UI rendering (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:60`). In code, the class validates dependencies, resolves authenticated versus guest APIs, resolves a LiveKit adapter, owns a DOM-free state model, and exposes lifecycle operations (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:61`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:232`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:248`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:266`).

Why this improves the architecture:

- Authenticated and guest sessions share one selected-room behavior class.
- The dashboard can subscribe to room events instead of decoding every transport detail inline.
- Room state has a serializable home outside DOM rendering code.
- Tests can exercise room lifecycle without needing a modal or real LiveKit connection.

### 3. Introduce explicit room adapters instead of one broad runtime object

The new room services separate responsibilities:

| Adapter | Responsibility | Evidence |
| --- | --- | --- |
| `WebMeetRoom` | Selected-room lifecycle, state hydration, realtime event validation, avatar projection, chat/presence API delegation. | `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:61` |
| `WebMeetRoomApi` | Authenticated MCP API versus public guest API surface. | `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-api.js:23`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-api.js:62` |
| `WebMeetRoomEvents` | Encoded WebMeet event build/parse plus mapping to typed `room:*` events. | `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-events.js:3`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-events.js:26` |
| `WebMeetRoomState` | Serializable state for meeting/session/participants/chat/transcript/agents/recordings/artifacts/livekit/media/avatar projection. | `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-state.js:9`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-state.js:33` |
| `WebMeetRoomLiveKit` | Browser LiveKit connection options, room construction, low-level event binding, disconnect cleanup. | `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js:7`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js:53` |

This is a clearer separation than the deleted `webmeet-room-runtime.js`, because the architecture now names the stable concepts directly instead of hiding API, state, transport, and event parsing inside one class.

### 4. Make event encoding a shared contract

`DS003` documents one encoded event format, `room:type:base64url_payload`, and says `webmeet-events.js` is the sole event contract module for store and browser UI code (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:48`, `webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:56`).

`WebMeetRoom` now parses incoming events and rejects forged LiveKit-origin events for wrong meeting IDs, missing sender identities, mismatched avatar participant IDs, or mismatched chat authors (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:129`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:146`).

Why this improves the architecture:

- Filesystem events, SSE, and LiveKit data-channel events share one shape.
- The UI receives normalized `room:*` events.
- LiveKit data-channel messages are no longer blindly trusted just because they arrived from the media plane.

### 5. Treat chat as durable-first, realtime-second

`DS003` now says chat has an authoritative persistence path through `webmeetAgent` and a best-effort realtime LiveKit path; LiveKit does not store history (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:68`).

In code:

- Authenticated chat send goes through `webmeet_chat_send`, and the tool derives the author from auth info (`webmeetAgent/tools/webmeet_tool.mjs:151`, `webmeetAgent/tools/webmeet_tool.mjs:243`).
- HTTP chat send also derives author from the request (`webmeetAgent/server/webmeet-api.mjs:442`).
- Durable storage appends the returned message to `payload.chatMessages` (`webmeetAgent/lib/webmeetStore.mjs:1753`, `webmeetAgent/lib/webmeetStore.mjs:1760`).
- The dashboard publishes a LiveKit `chat` payload only after the durable call succeeds.

Why this improves the architecture:

- Chat history is not dependent on currently connected LiveKit clients.
- Forged client-provided author IDs are no longer authoritative.
- Realtime delivery can fail without losing the message.

### 6. Make avatars live projections, not durable room profile state

`DS003` says participant avatars are live rendering projections and remote clients must not read another user's protected profile settings (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:64`).

In code, `WebMeetRoom.publishAvatarProjection()` updates in-browser room avatar state, publishes LiveKit participant attributes including `webmeetProfileAvatar`, sends a realtime avatar event, and emits a local room event (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:369`). This keeps avatar presentation in the media/realtime layer instead of making it part of durable room history.

Why this improves the architecture:

- The persistent room payload avoids copying protected user avatar settings into meeting records.
- Guest and authenticated participants can still render current avatar state while connected.
- Profile-avatar updates are scoped to the current participant and current browser projection.

### 7. Move low-level LiveKit connection handling into the room service tree

Commit `d65a4d2` adds `WebMeetRoomLiveKit` under `services/room`. It validates join payload media fields, creates a LiveKit `Room`, configures `adaptiveStream: false`, `dynacast: false`, `autoSubscribe: true`, optional `rtcConfig`, and exposes hook callbacks to the dashboard (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js:53`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js:65`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js:120`).

This preserves the media behavior documented in `DS004` (`webmeetAgent/docs/specs/DS004-livekit-media-runtime.md:59`) while moving the low-level LiveKit adapter out of generic dashboard controller files.

### 8. Harden public/protected route separation

The manifest declares protected `/services/webmeet/` and guest-forced `/public-services/webmeet/` HTTP services (`webmeetAgent/manifest.json:22`). The production profile exposes only the public/proxy service port, not the internal API port (`webmeetAgent/manifest.json:299`).

This aligns with the runtime invariant that direct internal ports are not a product API surface and guest access should come through router-mediated guest identity plus room token validation.

### 9. Replace sync meeting-record writes with async atomic replacement

`webmeetStore.mjs` imports `node:fs/promises` (`webmeetAgent/lib/webmeetStore.mjs:1`), writes JSON records with temp-file plus `rename()` (`webmeetAgent/lib/webmeetStore.mjs:192`), and documents that old `writeFileSync` behavior caused truncated-file reads (`webmeetAgent/lib/webmeetStore.mjs:193`). Event logs also use promise-based writes (`webmeetAgent/lib/webmeetQueue.mjs:1`, `webmeetAgent/lib/webmeetQueue.mjs:15`).

This fixes the most obvious persistence failure mode: a reader opening a file while a writer has truncated but not finished rewriting it.

## Does The Architecture Now Have A Clear Room Concept?

Mostly yes.

The clear conceptual model is:

- "Room" is the product/UI term.
- "Meeting record" is the durable application object.
- "LiveKit room" is the active media runtime object.
- `WebMeetRoom` is the browser selected-room orchestration boundary.

This is now written into the specs and reflected in code. The strongest evidence is `DS002`'s two-object room model (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:17`) and `DS003`'s explicit `WebMeetRoom` responsibility statement (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:60`).

The remaining ambiguity is naming and ownership. Backend APIs still mostly use "meeting" names, UI copy uses "room", and LiveKit also has "room". That is acceptable if the docs remain clear. More importantly, selected-room media hooks still live in dashboard controller code. So the architecture has a clear Room concept now, but not a fully completed Room implementation boundary.

## Separation Of Concerns Review

### Improved boundaries

| Concern | Before these commits | After these commits |
| --- | --- | --- |
| Selected room lifecycle | Mixed dashboard/runtime code. | `WebMeetRoom.join/connectLiveKit/disconnectLiveKit/leave/refreshState/destroy`. |
| Authenticated versus guest room calls | Less explicit runtime API split. | `AuthenticatedWebMeetRoomApi` versus `GuestWebMeetRoomApi`. |
| Event contract | Dashboard and store could drift. | Central event contract plus `WebMeetRoomEvents`. |
| Serializable room state | UI state and runtime state were more coupled. | `WebMeetRoomState` is DOM-free. |
| LiveKit room construction | Controller-owned class deleted in first commit, then reintroduced as room service in second commit. | `WebMeetRoomLiveKit`. |
| Durable persistence | Sync record write risk. | Async temp-file plus rename. |
| Chat authorship | Client-provided author fields had more influence. | Auth-derived author for MCP/API authenticated chat. |

### Remaining coupling

The main remaining coupling is that `WebMeetRoomLiveKit` is an adapter for connection and raw event binding, but the dashboard controller still supplies most semantic hooks:

- Track rendering and removal.
- Participant list synchronization.
- Active speaker state.
- Avatar republish and request behavior.
- Data-channel event decoding and forwarding.
- Meeting-detail refresh after LiveKit connect.

That hook body begins at `room-session-methods.js:316` and runs through the connected/error handling at `room-session-methods.js:493`. This is a reasonable intermediate state because the DOM-heavy pieces belong in UI controllers. If the target is a reusable room runtime, the next step is to move non-DOM room semantics out of the hook body and leave only actual rendering operations in the dashboard.

## Persistence And Filesystem Sync Review

### Durable WebMeet persistence

Durable meeting persistence no longer uses sync filesystem functions in the store path. `webmeetStore.mjs` uses `node:fs/promises`, and the record write path is asynchronous temp-file plus rename (`webmeetAgent/lib/webmeetStore.mjs:1`, `webmeetAgent/lib/webmeetStore.mjs:192`). The event queue also uses `node:fs/promises` (`webmeetAgent/lib/webmeetQueue.mjs:1`).

### Other WebMeet filesystem usage

There are still sync filesystem calls elsewhere in `webmeetAgent`, but they are not the durable meeting persistence write path:

- Static asset serving in `webmeet-public-proxy.mjs` uses `existsSync`, `statSync`, and `readFileSync` (`webmeetAgent/server/webmeet-public-proxy.mjs:764`, `webmeetAgent/server/webmeet-public-proxy.mjs:779`).
- Workspace root discovery uses `existsSync` to find `.ploinky` (`webmeetAgent/lib/workspacePaths.mjs:21`).
- Tests use sync file reads/writes.

Answer: persistence of room records and event logs has moved to async promise-based APIs. The broader WebMeet agent still contains sync filesystem calls for static asset serving, workspace discovery, and tests.

## Locking Review

The new locking mechanism has two useful properties:

- In-process read-modify-write operations for the same `meetingId` are serialized.
- Record replacement is atomic at the file-path level because writes go to a temp path and then rename into place.

It does not have these properties:

- It does not serialize writers across processes.
- It does not make event append plus payload save transactional.
- It does not protect against lost update races between MCP tool subprocesses and the HTTP API.

The safest design options are:

1. Add a filesystem-level per-meeting lock around the whole load/decrypt/mutate/encrypt/write sequence.
2. Move the meeting store to SQLite or another transactional local store.
3. Make MCP tools call the WebMeet API for every mutation so there is only one long-lived mutation owner.
4. Store append-only changes and fold them into snapshots instead of rewriting a whole encrypted payload for every mutation.

If the team keeps JSON records, option 1 is the smallest change. The lock must cover `recordMeetingEvent()` ordering too if event and payload consistency matters.

## What Gets Stored In Chat History?

Chat history lives in the encrypted meeting payload array `chatMessages` (`webmeetAgent/lib/webmeetStore.mjs:234`, `webmeetAgent/lib/webmeetStore.mjs:238`).

Each persisted chat message currently stores:

| Field | Meaning | UI visibility |
| --- | --- | --- |
| `id` | Generated `chat_<uuid>` id. | Not shown in chat list. Used for duplicate suppression and event reference. |
| `meetingId` | Owning meeting id. | Not shown. |
| `authorId` | Auth-derived user/agent id or guest participant id. | Used for self-message styling and fallback author display. |
| `authorName` | Auth-derived display name or guest display name. | Shown. |
| `message` | Chat body. | Shown. |
| `kind` | Message kind, defaults to `user`. | Not shown in the main chat list. |
| `createdAt` | Timestamp. | Shown after formatting. |
| `metadata` | Optional object, only stored when supplied. | Not shown in the main chat list. |

The main chat sidebar renders only `authorName` or `authorId`, formatted `createdAt`, and `message` (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js:407`). The chat panel itself is the right sidebar in the dashboard (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html:722`).

Persistent chat also creates a `CHAT_MESSAGE_CREATED` event with `meetingId` and `chatMessageId`, not the full message body (`webmeetAgent/lib/webmeetStore.mjs:1773`). The full readable history is the encrypted payload, not the event log.

## What Gets Stored But Is Not Shown In The Main UI?

### Stored in the meeting JSON record

The outer record stores identity and operational metadata:

- `meetingId`
- `workspaceId`
- `title`
- `roomType`
- `roomName`
- optional `guestToken`
- `status`
- `createdAt`, `updatedAt`, optional `closedAt`, optional `expiresAt`
- wrapped DEK and encryption metadata
- encrypted payload blob

The UI shows only some of this, mainly room title, created date, status, type icon, and admin actions. It does not show guest token, encryption metadata, wrapped DEK, room name internals, or most lifecycle timestamps directly.

### Stored in the encrypted payload

The encrypted payload contains these arrays (`webmeetAgent/lib/webmeetStore.mjs:234`):

- `members`
- `agents`
- `chatMessages`
- `transcriptSegments`
- `recordings`
- `artifacts`
- `tasks`
- `decisions`

Main UI visibility:

- `chatMessages`: visible in the right chat sidebar, but only author/time/body fields.
- `transcriptSegments`: visible in the sidebar transcript feed when loaded, and admin transcript modal paths exist. The sidebar shows speaker/time/text only (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js:425`).
- `tasks`: only title/status are rendered, and the current task container is hidden in the dashboard HTML (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js:435`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html:749`).
- `decisions`: only title is rendered, and the current decision container is hidden (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js:441`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/webmeet-dashboard-modal.html:750`).
- `recordings`: used for the admin recording button state and admin recordings modal; raw recording metadata is not shown in the main room surface (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-render-methods.js:332`, `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js:678`).
- `artifacts`: loaded for admins and guests, opened through an admin modal path, not shown in the main chat sidebar (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-action-methods.js:665`).
- `agents`: loaded for admins and guests, used for AI controls/participant badges, but full dispatch metadata is not displayed in the main room surface.
- `members`: rendered as participant cards/list projections, but internal member fields such as durable presence timestamps, pending LiveKit state, and auth attributes are not directly shown.

### Stored outside meeting JSON

- Recording MP4 files live outside the encrypted JSON under `/data/recordings/<meetingId>/<recordingId>.mp4`; only metadata and artifact references are in the payload (`webmeetAgent/docs/specs/DS002-room-state-and-access.md:48`).
- Persistent `.event` files store encoded event strings for meeting and workspace event polling (`webmeetAgent/docs/specs/DS003-application-runtime-and-events.md:56`, `webmeetAgent/lib/webmeetQueue.mjs:26`). These are not user-visible history; they drive refresh and realtime-ish notification flows.

### Stored in runtime, not durable history

- LiveKit participant attributes can contain `webmeetProfileAvatar` and user-id aliases; these are live participant projections, not durable room profile state (`webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js:390`).
- Browser session state contains the participant token returned by join, but tokens are not stored in the durable meeting payload.
- LiveKit data-channel chat payloads are realtime delivery hints after persistence, not chat history.

## Authenticated, Guest, And Admin Visibility

The dashboard data loader creates three practical visibility tiers:

| Caller | Loaded into dashboard state | Main UI visibility |
| --- | --- | --- |
| Authenticated non-admin | Meeting details and chat. | Rooms, participants, media, chat. |
| Authenticated admin | Meeting details, chat, transcript, artifacts, recordings, tasks, decisions, agents. | Main room plus admin actions and modals. |
| Guest | Public room state including participants, chat, transcript, artifacts, recordings, tasks, decisions, agents. | Main guest room primarily shows room/media/chat; some loaded data is not surfaced in visible controls. |

The relevant loader branch is `dashboard-data-methods.js:250` for guests and `dashboard-data-methods.js:285` for admin/non-admin authenticated users.

This asymmetry is worth deciding deliberately. Normal authenticated non-admin users receive less room metadata than guests currently receive through public guest state.

## Test Coverage Added Or Affected

The new `webmeet-room.test.mjs` exercises the new room boundary:

- same selected-room interface for guest and authenticated paths,
- join/connect/leave/session state behavior,
- strict missing-field failures,
- LiveKit-origin event rejection for forged sender/meeting payloads.

Other updated tests cover chat persistence through `webmeet_chat_send`, profile avatar projection staying out of durable room state, and LiveKit token metadata update grants. This is the right test direction for the architectural change. The missing test class is process-level concurrent mutation, because the current in-memory queue cannot catch cross-process lost updates.

## Overall Verdict

These commits materially improve the WebMeet room architecture. The biggest wins are the explicit split between durable meeting state and LiveKit runtime state, the new `WebMeetRoom` selected-room boundary, DOM-free room state, explicit auth/guest APIs, typed room events, durable-first chat, live-only avatar projections, and async atomic record replacement.

The architecture is not complete yet. The most important remaining issue is persistence correctness: process-local locking is not enough for a system where MCP tools and HTTP API calls can mutate the same JSON record from separate Node processes. The next architecture pass should make the store transactional across processes and then tighten the public guest state shape to match the access spec.
