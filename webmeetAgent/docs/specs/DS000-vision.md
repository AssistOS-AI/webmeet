---
id: DS000
title: WebMeet Agent Vision
status: implemented
owner: webmeet-team
summary: Defines webmeetAgent as the WebMeet application control plane and keeps media, AI-worker, STT, and infrastructure responsibilities separate.
---

# DS000 - WebMeet Agent Vision

## Introduction

`webmeetAgent` is the Ploinky application agent for WebMeet rooms inside AssistOSExplorer. It owns the application control plane: workspaces, room records, invite-scoped guest access, LiveKit participant token issuance, meeting chat, transcripts, artifacts, recording commands, AI dispatch metadata, and the Explorer WebMeet plugin.

Live audio, video, screen share, Redis coordination, TURN/STUN, LiveKit Egress, production TLS termination, and optional LiveKit AI workers are adjacent WebMeet runtime components. They are not owned by the `webmeetAgent` process, even when `webmeetAgent` enables them through its manifest.

## Core Content

WebMeet is split into explicit responsibility planes:

| Area | Owner | Contract |
| --- | --- | --- |
| WebMeet control plane | `webmeetAgent` | Durable workspaces, meetings, members, guest tokens, chat, transcript, artifacts, AI dispatch metadata, recording commands, and LiveKit participant JWTs. |
| Browser meeting UI | `webmeetAgent/IDE-plugins/webmeet-tool-button` | Explorer dashboard modal, guest page, LiveKit browser connection, media controls, chat composer, participant rendering, and browser-scoped media/avatar preferences. |
| Live media plane | `webmeetInfra/liveKitServerAgent` | LiveKit SFU, WebSocket signaling, WebRTC negotiation, RTP/RTCP forwarding, LiveKit data-channel delivery, Redis, Coturn, Egress, and production Nginx/Certbot. |
| Recording plane | `webmeetInfra/liveKitServerAgent` | Room composite egress worker and MP4 file writes under the shared recording volume. |
| Optional AI worker | `webmeetLivekitAiAgent` | Self-hosted LiveKit Agents worker that accepts explicit dispatch jobs and appears as a real LiveKit `AGENT` participant. |
| Optional STT service | `webmeetStt` | Internal Faster-Whisper service used by scribe agents; it must not expose public HTTP routes. |

The central invariant is that WebMeet rooms are discovered, authorized, and persisted by `webmeetAgent`. LiveKit rooms carry the live media session. Redis is infrastructure runtime state for LiveKit and Egress; it is not the WebMeet application database.

The primary implementation map is:

| Concern | Files |
| --- | --- |
| Manifest, HTTP service surfaces, data volumes, LiveKit env, dependencies | `manifest.json` |
| WebMeet process startup | `scripts/startAgent.sh` |
| Public/protected HTTP proxy and guest routing | `server/webmeet-public-proxy.mjs` |
| Local WebMeet REST API | `server/webmeet-api.mjs` |
| MCP tool surface | `tools/webmeet_tool.mjs`, `mcp-config.json` |
| Durable store, LiveKit tokens, LiveKit APIs, egress calls | `lib/webmeetStore.mjs` |
| Workspace/data paths | `lib/workspacePaths.mjs` |
| Payload encryption | `lib/webmeetCrypto.mjs` |
| Event append files | `lib/webmeetQueue.mjs` |
| WebMeet plugin API client | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/webmeet-api-client.js` |
| Browser LiveKit connection | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-livekit.js` |
| Room orchestration and lifecycle | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room.js` |
| Room event normalization and typed UI events | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-events.js` |
| Serializable room state model | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/room/webmeet-room-state.js` |
| Room session and LiveKit event handling | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/room-session-methods.js` |
| Browser media controls | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/webmeet-media-controller.js` |
| Chat and transcript UI behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/service-components/chat-transcript-component.js` |
| Guest browser session behavior | `IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/service-components/guest-session-manager.js` |

The active Explorer WebMeet UI path is the IDE plugin under `IDE-plugins/webmeet-tool-button`. Any older router-level `/webmeet` surface must not be treated as the current product entry point unless a future specification reintroduces it.

`webmeetAgent` must keep its persistent store under the configured WebMeet data directory, normally the `/data` container mount backed by `.ploinky/data/webmeetAgent/data`. Recording files live under `/data/recordings`, backed by `.ploinky/data/webmeet/recordings`, and are shared with the Egress service supervised by `liveKitServerAgent`.

`webmeetAgent` must not own infrastructure supervision. Starting `webmeetAgent` may enable `webmeetInfra/liveKitServerAgent`, but it must not implicitly launch the optional `webmeetLivekitAiAgent`; stacks that need self-hosted AI participants must enable that worker explicitly. `scripts/startAgent.sh` must only start the WebMeet API, the WebMeet MCP AgentServer, and the public/protected proxy. It must not import `@livekit/agents`, start Redis, start LiveKit Server, start Egress, or launch sibling Ploinky agents.

## Decisions & Questions

### Question #1: Why split WebMeet into a control plane and a media plane?

Response:
The WebMeet application needs durable authorization, room discovery, encrypted meeting records, guest invite validation, artifacts, and audit-friendly event files. LiveKit is optimized for low-latency media routing and transient room state. Keeping those responsibilities separate prevents media runtime state from becoming the product database and prevents application API latency from sitting on the live audio/video path.

### Question #2: Why does this agent depend on `liveKitServerAgent` instead of owning multiple infra agents?

Response:
The current `webmeetInfra` contract delivers one Ploinky agent, `liveKitServerAgent`, that supervises Redis, Coturn, LiveKit Server, LiveKit Egress, and production Nginx/Certbot inside one image. The older split infra-agent names are retired implementation history. `webmeetAgent` should enable and document the consolidated agent boundary.

### Question #3: Why keep the repository-level WebMeet architecture content inside the DS set?

Response:
DS files are the source of truth for future agent work. The root architecture document is useful narrative context, but durable requirements such as storage ownership, guest-route validation, LiveKit URL topology, event encoding, recording ownership, and Redis limits must live in the agent-local DS files where future changes are likely to begin.

## Conclusion

`webmeetAgent` remains correct while it stays the WebMeet application control plane, delegates live media infrastructure to `webmeetInfra/liveKitServerAgent`, keeps optional AI and STT workers separate, and preserves the documented storage, routing, and authorization boundaries.
