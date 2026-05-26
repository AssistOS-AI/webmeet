# WebMeet Agent

`webmeetAgent` is the AchillesIDE agent for WebMeet rooms, guest invite routing, LiveKit token issuance, chat, transcripts, recordings, meeting artifacts, and AI dispatch metadata.

## Components

- `webmeetAgent`
  - owns the WebMeet MCP surface, public guest service, and meeting runtime API
  - serves the HTTP API on `WEBMEET_API_PORT` (`8791` by default)
  - stores persistent meeting data under `.ploinky/data/webmeetAgent/data`
  - creates explicit LiveKit AI dispatches for the separate worker
- `webmeetInfra/liveKitServerAgent`
  - single Ploinky agent that supervises the WebMeet media runtime
  - includes LiveKit Server, LiveKit Egress, Redis, Coturn, and profile-specific production TLS services (Nginx + Certbot in `prod`) inside one container
- `webmeetLivekitAiAgent`
  - optional separate Ploinky agent for the self-hosted LiveKit Agents worker
  - owns the native `@livekit/agents` dependency tree
  - is launched explicitly by stacks that want self-hosted AI participants and is not part of the default Explorer stack

## Running

The agent is started through Ploinky, not directly with Docker Compose.

The WebMeet manifest:

- enables `webmeetInfra/liveKitServerAgent`
- starts `server/webmeet-api.mjs`
- starts the WebMeet public proxy
- starts the MCP `AgentServer`
- does not start the LiveKit AI worker process

Explorer only needs to enable `webmeetAgent` and the `webmeet` plugin for normal rooms, chat, camera, screen sharing, and recording flows.

WebMeet browser settings are user-scoped preferences stored in the browser, not per-room state. Device selection, audio processing, camera quality, screen share quality, and background privacy effects are opened from the dashboard modal header and apply across every room that the same Explorer user joins from that browser profile.

Microphone voice processing is local to the browser before the track is published to LiveKit. `enhanced` mode uses browser echo cancellation, a high-pass filter, locally bundled `@jitsi/rnnoise-wasm@0.2.1` sync build for `AudioWorklet`, optional hum filtering, compressor/limiter, and gain; `standard` uses browser processing; `off` disables browser voice cleanup. LiveKit remains the SFU and does not perform paid/cloud denoise for room participants. Vendor provenance is documented in `IDE-plugins/webmeet-tool-button/vendor/rnnoise/THIRD_PARTY_NOTICES.md`.

Background privacy uses a locally bundled LiveKit processor pipeline plus bundled MediaPipe assets. Blur and virtual-background images therefore stay inside the routed WebMeet frontend instead of depending on third-party CDN fetches at runtime.

## Optional AI Worker

WebMeet uses self-hosted LiveKit Agents for AI participants. The worker is not simulated in the WebMeet store and is not LiveKit Cloud or LiveKit Inference.

The worker registers with `WEBMEET_LIVEKIT_AGENT_NAME` and is attached to rooms by explicit admin dispatch. A separate worker stack must be running before dispatch can be accepted. Attach is considered successful only after the LiveKit `AGENT` participant appears in the room with WebMeet attributes for the meeting, agent type, and mode. A `CreateDispatch` response without a real participant is not persisted as an active agent.

The WebMeet store persists only dispatch metadata, chat, transcript, recordings, and artifacts. It does not create fake AI participants.

WebMeet rejects AI dispatch for empty rooms. When the last human participant leaves a room or times out from stale presence cleanup, WebMeet automatically detaches every active AI dispatch for that room.

## HTTP API

Default port: `8791`

Primary endpoints:

- Authenticated HTTP service base: `/services/webmeet`
- Guest/public HTTP service base: `/public-services/webmeet`
- `GET /healthz`
- `GET/POST /api/workspaces`
- `GET/POST /api/workspaces/:workspaceId/meetings`
- `GET /api/meetings/:meetingId`
- `POST /api/meetings/:meetingId/join`
- `GET/POST /api/meetings/:meetingId/chat`
- `GET/POST /api/meetings/:meetingId/transcript`
- `GET/POST /api/meetings/:meetingId/agents`
- `POST /api/meetings/:meetingId/recording/start`
- `POST /api/meetings/:meetingId/recording/stop`
- `GET /api/meetings/:meetingId/artifacts`
- `GET /api/meetings/:meetingId/tasks`
- `GET /api/meetings/:meetingId/decisions`

Room avatar projection is LiveKit-only rendering state, not durable meeting state. Joins do not persist avatar projections into the meeting record; after the participant connects, WebMeet publishes the effective avatar through LiveKit participant attributes and the reliable data channel. Authenticated users publish through the protected route, and guests publish through the scoped guest public-service route for their current joined participant identity. Avatar publish failures must not block joining a meeting.

## Runtime Validation

Runtime validation script:

```sh
node /code/server/validate-runtime.mjs
```

It checks:

- `webmeet-api`
- `livekit`
- `livekit-public`
- `livekit-egress`

The script reads `WEBMEET_*` endpoints and validates the dependencies declared by the agent.
