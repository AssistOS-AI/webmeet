# WebMeet Agent

`webmeetAgent` is the AchillesIDE agent for WebMeet rooms, roomId link routing, LiveKit token issuance, chat, room resources, and AI dispatch metadata.

## Components

- `webmeetAgent`
  - owns the WebMeet MCP surface and room store
  - does not serve a WebMeet-specific HTTP API or public proxy
  - stores persistent room data under `.ploinky/data/webmeetAgent/data`
  - creates explicit LiveKit AI dispatches for the separate worker
- `webmeetInfra/liveKitServerAgent`
  - single Ploinky agent that supervises the WebMeet media runtime
  - includes LiveKit Server, Redis, Egress, and semantic supervisor health inside one pinned container
  - binds signaling/API only to box loopback `127.0.0.1:7880`, owns the one box UDP mux on `7882`, and contains no local TURN, public TLS proxy, or certificate manager
- `webmeetLivekitAiAgent`
  - optional separate Ploinky agent for the self-hosted LiveKit Agents worker
  - owns the native `@livekit/agents` dependency tree
  - is launched explicitly by stacks that want self-hosted AI participants and is not part of the default Explorer stack

## Running

The agent is started through Ploinky, not directly with Docker Compose.

The WebMeet manifest:

- enables `webmeetInfra/liveKitServerAgent`
- starts the MCP `AgentServer`
- does not start the LiveKit AI worker process

Explorer only needs to enable `webmeetAgent` and the `webmeet` plugin for normal rooms, chat, camera, and screen sharing flows.

Each join resolves the current box-owned topology generation. Public signaling
uses Router `8080`; server-side LiveKit Twirp uses private Router `8081` with an
exact current-generation assertion. External TURN supplies UDP and TLS relay,
and Ploinky core brokers short-lived relay credentials only to allowed current-
generation consumers. WebMeet keeps no static relay URL or credential fallback.

WebMeet browser settings are user-scoped preferences stored in the browser, not per-room state. Device selection, audio processing, camera quality, screen share quality, and background privacy effects are opened from the dashboard header and apply across every room that the same Explorer user joins from that browser profile.

The main WebMeet application is the page component `webmeet-dashboard`, not a modal. WebMeet settings open in the dedicated WebSkel `webmeet-settings-modal`, which supports edge/corner resizing and a fullscreen toggle.

Microphone voice processing is local to the browser before the track is published to LiveKit. New users default to `auto`, which prefers the locally bundled Apache-2.0 RNNoise pipeline, detects sustained 50/60 Hz hum, applies conservative adaptive gain before final peak compression, and falls back to standard browser processing when needed. `custom`, `enhanced`, `standard`, and `off` remain explicit manual modes; editing gain, hum filtering, echo cancellation, noise suppression, or AGC while in `auto` switches the draft to `custom` instead of blocking the control. Saved settings are not overwritten. Remote participant volume normalization is also browser-local, default-enabled, and disabled per participant by an explicit manual volume override. LiveKit remains the self-hosted SFU and no paid/cloud denoise service or per-minute processing is used. Vendor provenance is documented in `IDE-plugins/webmeet-tool-button/vendor/rnnoise/THIRD_PARTY_NOTICES.md`.

Background privacy uses a locally bundled LiveKit processor pipeline plus bundled MediaPipe assets. Blur and virtual-background images therefore stay inside the routed WebMeet frontend instead of depending on third-party CDN fetches at runtime.

## Optional AI Worker

WebMeet uses self-hosted LiveKit Agents for AI participants. The worker is not simulated in the WebMeet store and is not LiveKit Cloud or LiveKit Inference.

The optional worker registers with its own worker-name setting and is attached to rooms by explicit admin dispatch. A separate worker stack must be running before dispatch can be accepted. Attach is considered successful only after the LiveKit `AGENT` participant appears in the room with WebMeet attributes for the meeting, agent type, and mode. A `CreateDispatch` response without a real participant is not persisted as an active agent.

The WebMeet store persists only dispatch metadata, chat, room resources, and participant state. It does not create fake AI participants.

WebMeet rejects AI dispatch for empty rooms. When the last human participant leaves a room or times out from stale presence cleanup, WebMeet automatically detaches every active AI dispatch for that room.

## Room Links

Guest-capable rooms use the same entrypoint as authenticated direct links:

```text
/explorer/index.html?roomId=room_<uuid>
```

Unauthenticated visitors receive a Ploinky guest session scoped to `webmeet:room:<roomId>` from the router. Authenticated users keep their normal Ploinky identity and can still see the dashboard and other allowed rooms.

Room avatar projection is LiveKit-only rendering state, not durable room state. Joins do not persist avatar projections into the room record; after the participant connects, WebMeet publishes the effective avatar through LiveKit participant attributes and the reliable data channel. Authenticated users and guests publish through the room-scoped MCP tool path. Avatar publish failures must not block joining a room.

## Runtime Validation

WebMeet no longer ships a dedicated HTTP server or server-side runtime validation script. Runtime checks should use the Ploinky agent lifecycle and the MCP room tools: verify `ploinky status`, container status, `webmeet_room_list`, and a room join response with a non-empty LiveKit participant token.
