# DS10 - Self-hosted LiveKit AI Agents

## Purpose

WebMeet AI participants are real self-hosted LiveKit Agents. WebMeet must not simulate AI presence with local store-only observer, assistant, or scribe jobs.

## Rules

- AI participants are attached by explicit LiveKit agent dispatch only.
- The dispatching tool is admin-only and uses the self-hosted LiveKit API configured by `WEBMEET_LIVEKIT_URL`, `WEBMEET_LIVEKIT_API_KEY`, and `WEBMEET_LIVEKIT_API_SECRET`.
- The LiveKit agent runtime registers with `WEBMEET_LIVEKIT_AGENT_NAME`; setting this name disables automatic dispatch and requires admin action per room.
- A successful attach requires a real LiveKit agent participant in the target room. A `CreateDispatch` HTTP 200 response is not enough, because LiveKit can persist a dispatch record while no worker has accepted the job.
- Agent participants must expose LiveKit participant attributes for `webmeetAgent`, `webmeetAgentName`, `webmeetMeetingId`, `webmeetAgentType`, and `webmeetAgentMode` so WebMeet can confirm the exact dispatched runtime participant without simulating presence.
- WebMeet store persists dispatch metadata, chat, transcript, recordings, artifacts, tasks, and decisions. It does not create fake AI participants.
- Guest users and normal logged-in users can see AI output but cannot attach, control, or finalize agents.
- LiveKit Cloud and LiveKit Inference are not required or enabled implicitly. Provider credentials for LLM/STT/TTS must be configured explicitly.
- The AI worker is optional and owned by the separate `webmeetLivekitAiAgent` Ploinky agent. It may be launched by Explorer through a no-wait dependency edge, but it must never block default WebMeet readiness.
- Base WebMeet startup must not install the worker's native LiveKit dependency tree; that dependency tree belongs only to `webmeetLivekitAiAgent/package.json`.
- Scribe agents use the internal `webmeetStt` service through `WEBMEET_STT_URL` and persist transcript segments through `webmeetAgent` with the shared derived `WEBMEET_AGENT_INTERNAL_TOKEN`; neither value should require manual local setup.

## Runtime

When launched by Ploinky, `webmeetLivekitAiAgent/server/livekit-agent.mjs` runs as its own Ploinky agent: on the `webmeet` bridge in `default` and `dev`, and on the host network in `prod`. The process connects to the self-hosted LiveKit server and waits for explicit dispatch jobs. When the worker is still preparing or has failed, WebMeet still starts the API, public proxy, and MCP server without requiring `@livekit/agents` inside `webmeetAgent`.

The production worker uses `network.mode: "host"` to match production LiveKit's host-network media topology. In that profile the worker uses `WEBMEET_LIVEKIT_AGENT_URL=http://127.0.0.1:7880`, while bridge-resident `webmeetAgent` continues to use `WEBMEET_LIVEKIT_URL=http://host.containers.internal:7880` for control-plane calls. `webmeetAgent` publishes localhost-only prod ports for its public proxy and internal API so the host-network worker can reach `http://127.0.0.1:18791` for chat and transcript persistence without creating a public bypass around the Ploinky router.

`webmeetAgent/scripts/startAgent.sh` must not import `@livekit/agents`, start `server/livekit-agent.mjs`, or depend on the worker dependency cache. Admin dispatch attempts go directly through LiveKit and succeed only when the separate worker accepts the dispatch and appears as a real LiveKit `AGENT` participant.

## Validation

Validation requires syntax checks for the WebMeet API, store, tool, public proxy, and `webmeetLivekitAiAgent` entrypoint, plus a runtime smoke test where an admin dispatches the assistant agent and the scribe agent. The assistant check must confirm a real LiveKit `AGENT` participant appears. The scribe check must confirm a real LiveKit `AGENT` participant appears and that microphone audio produces persisted transcript segments.
