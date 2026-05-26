# WebMeet Room Architecture Remediation Plan

Plan date: 2026-05-26

Source review: `webmeetAgent/docs/reviews/2026-05-25-webmeet-room-architecture-commits.md`

This plan addresses every finding from the WebMeet room architecture review, plus the follow-up filesystem performance question. The recommended order is correctness first, public contract second, architecture cleanup third, and performance polish last.

## Goals

- Prevent lost durable room updates when MCP tool subprocesses and the HTTP API mutate the same meeting.
- Prevent persistent event logs from claiming state that was not saved in the encrypted meeting payload.
- Make guest-visible room state match the access contract.
- Finish the room boundary incrementally without forcing a risky UI/media rewrite.
- Align MCP tool schemas with the new auth-derived chat author model.
- Remove remaining sync filesystem calls from request hot paths where they can block long-lived Node processes.

## Non-Goals

- Do not replace the WebMeet JSON store with a database in the first remediation pass.
- Do not rewrite the whole dashboard modal or media controller.
- Do not change the product-visible meaning of team rooms, guest rooms, recordings, or avatars unless a contract decision is explicitly called out below.
- Do not make LiveKit the durable source of truth for WebMeet room data.

## Recommended Execution Order

| Phase | Priority | Workstream | Why first/next |
| --- | --- | --- | --- |
| 0 | P0 | Baseline tests and instrumentation | Create a safety net before changing store semantics. |
| 1 | P1 | Cross-process meeting lock | Prevent lost updates, the highest-risk finding. |
| 2 | P1 | Event/payload consistency | Prevent event logs and encrypted payloads from diverging. |
| 3 | P2 | Guest state contract | Close the public API exposure ambiguity. |
| 4 | P2 | Chat MCP schema cleanup | Low-risk contract fix that unblocks clients already sending only `meetingId` and `message`. |
| 5 | P3 | Room boundary completion | Architectural cleanup after correctness is stable. |
| 6 | P3 | Sync filesystem performance cleanup | Useful, but less risky than data consistency. |
| 7 | P0 | Docs, specs, and regression suite | Keep DS specs and implementation aligned. |

## Phase 0: Baseline And Reproduction Tests

### Objectives

- Capture the current failure modes with tests before implementation.
- Make concurrency regressions visible in CI or local test runs.

### Implementation Steps

1. Add a store-level concurrency test that creates one temporary WebMeet workspace, creates one meeting, then spawns many independent Node processes that append chat messages to the same meeting through `webmeet_tool.mjs` or a tiny test helper importing `appendMeetingChat()`.
2. Assert that all messages survive in `payload.chatMessages` after the processes exit.
3. Add a variant where one process appends transcript or presence while another appends chat, so the test proves independent payload arrays do not overwrite one another.
4. Add an event consistency test that records the expected number of persistent chat events and compares it with the final payload.
5. Add a guest-state contract test that calls the public guest state path and snapshots the allowed fields.

### Acceptance Criteria

- The current code should fail or be marked as expected-failing for the cross-process lost-update case.
- Tests must not depend on LiveKit being available.
- Temporary workspaces and derived master keys must be isolated per test.

## Phase 1: Cross-Process Meeting Lock

### Finding Addressed

The current `meetingMutationQueues` lock is process-local. It serializes mutations inside one Node process but not across separate MCP tool invocations or between MCP tools and the long-lived HTTP API process.

### Recommended Design

Keep the in-process promise queue, but add a filesystem lock around the full meeting read/decrypt/mutate/encrypt/write sequence. Use an atomic lock directory or exclusive lock file under the WebMeet data directory.

Recommended path shape:

```text
<WEBMEET_DATA_DIR>/locks/meetings/<meetingId>.lock/
```

Recommended acquisition:

- Use `fs.mkdir(lockDir)` as the atomic cross-process acquisition primitive.
- Write `owner.json` inside the lock directory with `pid`, `hostname`, `startedAt`, `meetingId`, and a random `token`.
- Retry with small jittered backoff.
- Use a bounded wait time, for example 5 seconds by default, configurable by env for tests.
- Detect stale locks by age. Start conservatively, for example 60 seconds. If stale, attempt cleanup and retry.
- Release by verifying the random token in `owner.json`, then removing the lock directory.

The random token matters because PID reuse and stale cleanup can otherwise cause one process to remove another process's fresh lock.

### Code Targets

- `webmeetAgent/lib/webmeetStore.mjs`
- `webmeetAgent/lib/workspacePaths.mjs`
- Tests under `webmeetAgent/tests/unit/`

### Implementation Steps

1. Add `locksDir` and `meetingLocksDir` to `getWorkspacePaths()`.
2. Add helper functions in `webmeetStore.mjs`:
   - `acquireMeetingLock(context, meetingId, options)`
   - `releaseMeetingLock(lockHandle)`
   - `withMeetingLock(context, meetingId, fn, options)`
3. Wrap the existing `mutateMeeting()` run body with `withMeetingLock()`.
4. Keep `meetingMutationQueues` in place. It still reduces local contention and avoids lock stampedes inside the long-lived API process.
5. Audit every function that mutates a meeting record. Every mutation should flow through `mutateMeeting()` or a new explicitly locked helper.
6. Audit non-meeting mutations. If workspace record creation/update can race, add a separate workspace lock in a follow-up patch.
7. Ensure lock cleanup runs in `finally`.
8. Add test-only knobs for low lock TTL or artificial mutator delay if needed to make concurrency tests deterministic.

### Acceptance Criteria

- Running 20 to 100 concurrent chat appends from separate Node processes preserves every message.
- A concurrent chat append and transcript append both survive.
- A process crash while holding a lock leaves a stale lock that a later process can safely recover after TTL.
- No test observes partial JSON reads.
- Lock files are cleaned up after successful and failed mutations.

### Risks And Mitigations

- Risk: stale lock cleanup removes a valid active lock.
  Mitigation: token verification, conservative TTL, and cleanup only when age exceeds TTL.

- Risk: lock waits slow down chat under bursty load.
  Mitigation: lock critical sections should contain only filesystem read/decrypt/mutate/encrypt/write and event staging. Do not call LiveKit, network APIs, or UI work while holding the lock.

- Risk: nested meeting mutations deadlock.
  Mitigation: audit call chains and keep the rule that a function inside `mutateMeeting()` must not call another meeting mutator for the same meeting.

## Phase 2: Event And Payload Consistency

### Finding Addressed

Persistent events are currently appended from inside mutation callbacks before the encrypted payload save finishes. That can create event logs for state that never persisted, and it can worsen cross-process divergence.

### Recommended Design

Move from "write event during mutation" to "stage event during mutation, save payload, then publish event." Do this while holding the cross-process meeting lock from Phase 1.

Minimal design:

- Mutators return event intents instead of calling `recordMeetingEvent()` directly.
- `mutateMeeting()` saves the meeting payload first.
- After save succeeds, `mutateMeeting()` appends meeting/workspace event logs.
- Release the lock only after event append attempts complete.

Stronger design, recommended if the team wants event delivery guarantees:

- Add an encrypted payload outbox, for example `eventOutbox`.
- On mutation, save both the state change and event intent into the encrypted payload.
- After the save, append `.event` files.
- After successful event append, remove the outbox entries in a second locked save.
- On store context startup, room read, or next mutation, flush pending outbox events.

The minimal design fixes the most dangerous direction: event exists but payload does not. The stronger design also handles payload exists but event append failed.

### Code Targets

- `webmeetAgent/lib/webmeetStore.mjs`
- `webmeetAgent/lib/webmeetQueue.mjs`
- `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-events.js`
- Event-related tests.

### Implementation Steps

1. Introduce an event intent type internally:
   - `scope`: `meeting` or `workspace`
   - `meetingId`
   - `workspaceId` when needed
   - `type`
   - `data`
2. Change mutators to push event intents rather than calling `recordMeetingEvent()` directly.
3. Update `mutateMeeting()` to:
   - acquire cross-process lock,
   - load and decrypt,
   - run mutator,
   - save record,
   - append staged events,
   - release lock.
4. Update create/delete paths separately because they may not use the same existing mutation flow.
5. If using the stronger outbox design, add `flushMeetingEventOutbox()` and call it from store startup and before returning event lists.
6. Make event append idempotent by deriving file names from event id, and tolerate `EEXIST` for duplicate flush attempts.

### Acceptance Criteria

- If payload save fails, no new `.event` file appears.
- If two concurrent mutations succeed, final payload and event log both include both mutations.
- If event append is retried, duplicate event files are not created.
- Existing UI event polling still receives room creation, rename, participant, chat, transcript, agent, recording, and artifact events.

## Phase 3: Guest State Contract

### Finding Addressed

`getGuestMeetingDetails()` returns `transcript`, `artifacts`, `recordings`, `tasks`, `decisions`, and `agents` even though `DS002` says the guest public API must not expose administrative artifacts.

### Contract Decision

Recommended default: narrow guest state now.

Guest `guest-state` should return only:

- public meeting view,
- participants,
- chat.

Transcript should remain available only through the explicitly scoped transcript download/read path if the product wants guest transcript access. Artifacts, recordings, tasks, decisions, and AI agent metadata should not be included in generic guest room state unless the product explicitly marks them public.

### Code Targets

- `webmeetAgent/lib/webmeetStore.mjs`
- `webmeetAgent/server/webmeet-api.mjs`
- `webmeetAgent/server/webmeet-public-proxy.mjs`
- `webmeetAgent/IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/dashboard-data-methods.js`
- `webmeetAgent/docs/specs/DS002-room-state-and-access.md`
- `webmeetAgent/docs/specs/DS003-application-runtime-and-events.md`

### Implementation Steps

1. Update `getGuestMeetingDetails()` to return a public state object with only allowed fields.
2. Ensure guest dashboard code already handles missing arrays by defaulting to `[]`. If not, add defaults at the UI boundary.
3. Ensure admin modals and controls are not reachable from guest shell actions.
4. Add unit tests proving guest state does not include:
   - `artifacts`
   - `recordings`
   - `tasks`
   - `decisions`
   - `agents`
   - transcript, unless explicitly decided public
5. Update DS specs to state the exact `guest-state` response shape.
6. If the product does need guest-visible artifacts later, add an explicit public artifact model with per-artifact visibility, not a blanket payload return.

### Acceptance Criteria

- Guest state endpoint returns no administrative arrays.
- Guest chat and participant rendering still work.
- Authenticated admin data loading is unchanged.
- Authenticated non-admin data loading is unchanged.
- Specs match implementation.

## Phase 4: MCP Chat Schema Cleanup

### Finding Addressed

`webmeet_chat_send` still declares `authorId` and `authorName` as required even though the tool derives authorship from auth info and ignores caller-provided author fields.

### Implementation Steps

1. Update `webmeetAgent/mcp-config.json` so `webmeet_chat_send` requires only:
   - `meetingId`
   - `message`
2. Keep `authorId` and `authorName` ignored if old clients still provide them.
3. Update any tests that assert the old schema.
4. Add a schema test that fails if `authorId` or `authorName` become required again.
5. Search for callers passing author fields and simplify them where safe.
6. Update docs/specs if they describe chat-send input.

### Acceptance Criteria

- Chat send still rejects unauthenticated authors.
- Chat send still stores auth-derived `authorId` and `authorName`.
- Schema no longer requires meaningless author fields.
- Existing callers that still pass author fields continue to work.

## Phase 5: Complete The Room Boundary Incrementally

### Finding Addressed

The new `WebMeetRoom` concept is real, but the dashboard still owns many selected-room runtime semantics through `connectRoom()` and the large LiveKit hook body.

### Target Boundary

Keep this split:

| Owner | Should own |
| --- | --- |
| `WebMeetRoom` | room identity, selected-room lifecycle, API calls, WebMeet event validation, chat send, avatar projection protocol, participant semantic updates |
| `WebMeetRoomLiveKit` | LiveKit client creation, connect/disconnect, raw LiveKit event binding, media option setup |
| Dashboard controllers | DOM rendering, media track element attachment/removal, buttons, modals, layout, user feedback |
| `WebMeetRoomState` | serializable state only, no DOM and no network |

### Implementation Steps

1. Pass the actual `this.roomLiveKit` adapter into `WebMeetRoom` instead of `livekit: null`.
2. Change `WebMeetRoom.connectLiveKit()` to use its current session and to accept or construct a hook adapter.
3. Move data-channel event decoding and validation fully into `WebMeetRoom`.
4. Move avatar republish/request orchestration into `WebMeetRoom`.
5. Move participant attribute parsing into `WebMeetRoom` or a DOM-free participant projection helper.
6. Leave track rendering and media element management in the dashboard.
7. Shrink `room-session-methods.js` so it mostly adapts room events to DOM operations.
8. Add tests around room-level handling of:
   - LiveKit data-channel chat event,
   - avatar request and projection,
   - participant attributes,
   - disconnect cleanup.

### Suggested Refactor Sequence

1. Data-channel decode/validate move.
2. Avatar projection orchestration move.
3. Participant attribute projection move.
4. LiveKit adapter injection cleanup.

Each step should be separately testable and should keep the dashboard working.

### Acceptance Criteria

- `WebMeetRoom` is constructed with a real LiveKit adapter in the normal dashboard path.
- `room-session-methods.js` no longer owns non-DOM room semantics.
- Media track rendering remains stable.
- Existing unit tests pass.
- Add or update browser/manual verification notes for join, chat, avatar, leave, and reconnect.

## Phase 6: Sync Filesystem Performance Cleanup

### Finding Addressed

Durable room persistence is async now, but the long-lived public proxy still uses sync filesystem calls for static asset serving. Sync FS can block the proxy event loop while serving requests.

### Implementation Steps

1. Convert `resolveAssetPath()` in `webmeet-public-proxy.mjs` to async.
2. Replace `existsSync` and `statSync` with `fs.promises.stat()`.
3. Replace `readFileSync` in `sendAsset()` with `await fs.promises.readFile()` or use a stream.
4. Keep path-root validation before reading the file.
5. Add a unit test for path traversal rejection and successful asset serving.
6. Leave `workspacePaths.mjs` `existsSync` alone unless profiling shows it matters. It is not the durable persistence path, and for MCP subprocesses the process startup cost dominates that single lookup.

### Acceptance Criteria

- No sync FS calls remain in request-serving paths.
- Asset requests still return correct content type and `X-Content-Type-Options`.
- Path traversal attempts still return 404.
- Room persistence still uses async temp-file plus rename.

## Phase 7: Documentation And Spec Updates

### Documents To Update

- `webmeetAgent/docs/specs/DS002-room-state-and-access.md`
- `webmeetAgent/docs/specs/DS003-application-runtime-and-events.md`
- `webmeetAgent/docs/specs/DS004-livekit-media-runtime.md` if LiveKit ownership details change
- This remediation plan, marking completed phases if the team wants it as a tracker

### Required Spec Changes

1. Replace "meeting mutations are serialized per `meetingId` inside the agent process" with the new cross-process locking contract.
2. Document event ordering and whether the implementation uses minimal deferred events or an outbox.
3. Document the exact guest state response shape.
4. Document that authenticated chat send derives author identity from router auth and does not accept caller-supplied authorship.
5. Document which room semantics belong in `WebMeetRoom` versus dashboard controllers after Phase 5.

## Verification Matrix

| Area | Verification |
| --- | --- |
| Cross-process lock | Spawn many concurrent tool subprocesses; assert no lost chat/transcript/presence updates. |
| Atomic JSON | Stress read while writing; assert no truncated JSON parse failures. |
| Event consistency | Assert payload message count and event count match after concurrent writes. |
| Guest API | Assert guest state shape excludes admin arrays. |
| Chat schema | Assert MCP schema requires only `meetingId` and `message`. |
| Auth-derived chat | Assert spoofed `authorId` input cannot change persisted author. |
| Room boundary | Unit-test room events without DOM; manually join and leave a room in dashboard. |
| Static assets | Assert public proxy serves allowed assets asynchronously and rejects traversal. |

## Suggested Pull Request Split

### PR 1: Cross-Process Store Lock

- Add filesystem meeting lock.
- Add concurrent subprocess tests.
- Keep event behavior mostly unchanged except where necessary for lock integration.

### PR 2: Deferred Events Or Event Outbox

- Stage events after successful payload save.
- Add event consistency tests.
- Update specs for event ordering.

### PR 3: Public Guest Contract And Chat Schema

- Narrow guest state.
- Fix `webmeet_chat_send` schema.
- Update specs and tests.

### PR 4: Room Boundary Cleanup

- Move non-DOM room semantics into `WebMeetRoom`.
- Inject real `WebMeetRoomLiveKit`.
- Keep UI rendering behavior stable.

### PR 5: Async Static Asset FS

- Convert proxy asset FS calls to async.
- Add path traversal and asset-serving tests.

## Open Decisions

1. Should guest users see transcript in generic room state, or only through an explicit transcript download/read endpoint?
2. Should event delivery be best-effort after payload save, or should WebMeet add a durable encrypted event outbox?
3. What lock timeout and stale-lock TTL should production use?
4. Should workspace records get the same cross-process lock in the first PR, or only after meeting locks are stable?
5. Should chat metadata ever be UI-visible, or remain internal only?

## Definition Of Done

The remediation is complete when:

- Concurrent MCP/API mutations cannot lose meeting payload updates.
- Persistent event logs cannot announce unsaved state.
- Guest public state exposes only documented public fields.
- `webmeet_chat_send` schema matches auth-derived implementation.
- `WebMeetRoom` owns selected-room lifecycle and non-DOM room semantics.
- Remaining sync filesystem calls are outside request hot paths or explicitly justified.
- DS specs match the implemented contracts.
- The review findings can be re-run and closed without new P1/P2 issues.
