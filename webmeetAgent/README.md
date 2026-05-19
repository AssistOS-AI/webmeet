# WebMeet Agent

`webmeetAgent` is the AchillesIDE agent for WebMeet rooms, guest invite routing, LiveKit token issuance, chat, transcripts, recordings, meeting artifacts, and AI dispatch metadata.

## Components

- `webmeetAgent`
  - owns the WebMeet MCP surface, public guest service, and meeting runtime API
  - serves the HTTP API on `WEBMEET_API_PORT` (`8791` by default)
  - stores persistent meeting data under `.ploinky/data/webmeetAgent/data`
  - creates explicit LiveKit AI dispatches for the separate worker
- `webmeetInfra/stack`
  - provides the WebMeet media infrastructure declared by the manifest
  - includes LiveKit Server, LiveKit Egress, Redis, Coturn, and profile-specific production TLS services
- `webmeetLivekitAiAgent`
  - optional separate Ploinky agent for the self-hosted LiveKit Agents worker
  - owns the native `@livekit/agents` dependency tree
  - starts through a no-wait dependency edge so it never blocks Explorer readiness

## Running

The agent is started through Ploinky, not directly with Docker Compose.

The WebMeet manifest:

- enables `webmeetInfra/stack`
- starts `server/webmeet-api.mjs`
- starts the WebMeet public proxy
- starts the MCP `AgentServer`
- does not start the LiveKit AI worker process

Explorer only needs to enable `webmeetAgent` and the `webmeet` plugin for normal rooms, chat, camera, screen sharing, and recording flows.

## Optional AI Worker

WebMeet uses self-hosted LiveKit Agents for AI participants. The worker is not simulated in the WebMeet store and is not LiveKit Cloud or LiveKit Inference.

The worker registers with `WEBMEET_LIVEKIT_AGENT_NAME` and is attached to rooms by explicit admin dispatch. The no-wait background launch must have completed successfully before dispatch can be accepted. Attach is considered successful only after the LiveKit `AGENT` participant appears in the room with WebMeet attributes for the meeting, agent type, and mode. A `CreateDispatch` response without a real participant is not persisted as an active agent.

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

Authenticated joins may include a sanitized `avatar` projection in the join body so the newly created participant roster entry already carries `profileAvatar` for reloads and reconnects before any follow-up avatar refresh call runs.

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
