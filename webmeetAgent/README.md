# WebMeet Agent

`webmeetAgent` este agentul AchillesIDE pentru colaborare audio/video, chat, transcript, recording și artifacts de meeting.

## Componente

- `webmeetAgent`
  - MCP surface pentru Explorer
  - HTTP API pe `WEBMEET_API_PORT` (implicit `8791`)
  - queue persistentă pentru jobs/events sub `.ploinky/webmeet`
  - worker AI separat pornit din bootstrap
- `basic/webmeetLivekitServer`
- `basic/webmeetLivekitEgress`
- `basic/webmeetCoturn`
- `basic/webmeetRedis`

## Rulare

Agentul se pornește prin Ploinky, nu direct cu Docker Compose.

Manifestul agentului:
- activează dependențele shared WebMeet din `basic`
- pornește `AgentServer`
- pornește în paralel:
  - `server/webmeet-api.mjs`
  - `server/webmeet-worker.mjs`

## HTTP API

Port implicit: `8791`

Endpoint-uri principale:
- `GET /healthz`
- `GET/POST /api/workspaces`
- `GET/POST /api/workspaces/:workspaceId/channels`
- `GET/POST /api/channels/:channelId/meetings`
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
- `livekit-server`
- `livekit-egress`
- `coturn`
- `redis`

## Transcript

UI-ul Explorer suportă:
- append manual de transcript
- captură automată din browser prin `SpeechRecognition` / `webkitSpeechRecognition`, dacă browserul o expune

## AI workers

Workerul separat consumă jobs persistente pentru:
- `observer_refresh`
- `assistant_reply`
- `scribe_finalize`

Rezultatele sunt persistate în store-ul WebMeet și vizibile în UI.
