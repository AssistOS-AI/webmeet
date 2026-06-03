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
  - includes LiveKit Server, Redis, Coturn, and profile-specific production TLS services (Nginx + Certbot in `prod`) inside one container
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

WebMeet browser settings are user-scoped preferences stored in the browser, not per-room state. Device selection, audio processing, camera quality, screen share quality, and background privacy effects are opened from the dashboard modal header and apply across every room that the same Explorer user joins from that browser profile.

Microphone voice processing is local to the browser before the track is published to LiveKit. `enhanced` mode uses browser echo cancellation, a high-pass filter, locally bundled `@jitsi/rnnoise-wasm@0.2.1` sync build for `AudioWorklet`, optional hum filtering, compressor/limiter, and gain; `standard` uses browser processing; `off` disables browser voice cleanup. LiveKit remains the SFU and does not perform paid/cloud denoise for room participants. Vendor provenance is documented in `IDE-plugins/webmeet-tool-button/vendor/rnnoise/THIRD_PARTY_NOTICES.md`.

Background privacy uses a locally bundled LiveKit processor pipeline plus bundled MediaPipe assets. Blur and virtual-background images therefore stay inside the routed WebMeet frontend instead of depending on third-party CDN fetches at runtime.

## Optional AI Worker

WebMeet uses self-hosted LiveKit Agents for AI participants. The worker is not simulated in the WebMeet store and is not LiveKit Cloud or LiveKit Inference.

The worker registers with `WEBMEET_LIVEKIT_AGENT_NAME` and is attached to rooms by explicit admin dispatch. A separate worker stack must be running before dispatch can be accepted. Attach is considered successful only after the LiveKit `AGENT` participant appears in the room with WebMeet attributes for the meeting, agent type, and mode. A `CreateDispatch` response without a real participant is not persisted as an active agent.

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
