# WebMeet Agent

`webmeetAgent` este agentul AchillesIDE pentru colaborare audio/video, chat, transcript, recording și artifacts de meeting.

## Componente

- `webmeetAgent`
  - owner pentru MCP surface, bootstrap și runtime WebMeet
  - HTTP API pe `WEBMEET_API_PORT` (implicit `8791`)
  - event log persistent sub `.ploinky/webmeet`
  - runtime self-hosted pentru LiveKit Agents, atașat explicit în camere de admin
- `webmeetInfra/stack`
  - dependența de infrastructură declarată de agent
  - include LiveKit, egress și restul serviciilor necesare runtime-ului WebMeet

## Rulare

Agentul se pornește prin Ploinky, nu direct cu Docker Compose.

Manifestul agentului:
- activează `webmeetInfra/stack` din `manifest.json`
- pornește `AgentServer`
- pornește în paralel:
  - `server/webmeet-api.mjs`
  - `server/livekit-agent.mjs`

Explorer trebuie doar să enable-uiască `webmeetAgent` și pluginul `webmeet`.
Provisioning-ul pentru LiveKit nu mai aparține host-ului Explorer sau unui flow separat din Ploinky.

## HTTP API

Port implicit: `8791`

Endpoint-uri principale:
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

## Validare runtime

Script:

```sh
node /code/server/validate-runtime.mjs
```

Verifică:
- `webmeet-api`
- `livekit`
- `livekit-public`
- `livekit-egress`

Scriptul citește endpoint-urile din `WEBMEET_*` și validează dependențele declarate de agent.

## Transcript

UI-ul Explorer suportă:
- append manual de transcript
- captură automată din browser prin `SpeechRecognition` / `webkitSpeechRecognition`, dacă browserul o expune

## AI agents

WebMeet folosește LiveKit Agents self-hosted, nu LiveKit Cloud și nu LiveKit Inference implicit. Agentul este pornit local prin `server/livekit-agent.mjs`, se înregistrează cu `WEBMEET_LIVEKIT_AGENT_NAME` și este atașat în camere prin explicit dispatch de către admin.

Agent attach is considered successful only after the LiveKit `AGENT` participant appears in the room with WebMeet attributes for the meeting, agent type, and mode. A `CreateDispatch` response without a real participant is not persisted as an active agent.

Store-ul WebMeet păstrează doar metadata de dispatch, chat/transcript, recordings și artifacts. Nu mai există proces AI local store-based care simulează observer/assistant/scribe în store.
