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
- `WEBMEET_LIVEKIT_AGENT_ENABLED=false` disables WebMeet admin dispatch by default. Operators must set this guard to `true` and confirm the background worker is running before admin attach requests can dispatch AI participants.
- Base WebMeet startup must not install the worker's native LiveKit dependency tree; that dependency tree belongs only to `webmeetLivekitAiAgent/package.json`.

## Runtime

When launched by Ploinky, `webmeetLivekitAiAgent/server/livekit-agent.mjs` runs as its own Ploinky agent on the `webmeet` network. The process connects to the self-hosted LiveKit server and waits for explicit dispatch jobs. When the worker is still preparing or has failed, WebMeet still starts the API, public proxy, and MCP server without requiring `@livekit/agents` inside `webmeetAgent`.

Operator dispatch opt-in:

```bash
ploinky var WEBMEET_LIVEKIT_AGENT_ENABLED true
ploinky start explorer 8080
```

## Validation

Validation requires syntax checks for the WebMeet API, store, tool, public proxy, and `webmeetLivekitAiAgent` entrypoint, plus a runtime smoke test where an admin dispatches the agent and the agent appears as a LiveKit participant.
