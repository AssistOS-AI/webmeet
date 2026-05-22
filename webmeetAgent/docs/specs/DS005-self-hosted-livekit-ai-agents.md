---
id: DS005
title: Self-hosted LiveKit AI Agents
status: implemented
owner: webmeet-team
summary: Defines explicit LiveKit AI participant dispatch, optional worker ownership, scribe/STT integration, and no-fake-participant guarantees.
---

# DS005 - Self-hosted LiveKit AI Agents

## Introduction

WebMeet AI participants are real self-hosted LiveKit Agents. WebMeet must not simulate AI presence with local store-only observer, assistant, or scribe jobs.

## Core Content

AI participants are attached by explicit LiveKit agent dispatch only. The dispatching tool is admin-only and uses the self-hosted LiveKit API configured by `WEBMEET_LIVEKIT_URL`, `WEBMEET_LIVEKIT_API_KEY`, and `WEBMEET_LIVEKIT_API_SECRET`.

The optional worker is owned by the separate `webmeetLivekitAiAgent` Ploinky agent. It registers with `WEBMEET_LIVEKIT_AGENT_NAME`, accepts dispatches, joins the target LiveKit room, and exposes LiveKit participant attributes for `webmeetAgent`, `webmeetAgentName`, `webmeetMeetingId`, `webmeetAgentType`, and `webmeetAgentMode`.

`webmeetAgent` must not import `@livekit/agents`, start `server/livekit-agent.mjs`, depend on the worker dependency cache, or reintroduce `webmeetAgent/package.json` for the AI worker. The worker's native LiveKit dependency tree belongs only to `webmeetLivekitAiAgent/package.json`.

The worker may be launched through a no-wait manifest edge so it never blocks default WebMeet readiness. Normal rooms, chat, guest access, camera, screen share, and recording flows must remain usable when the optional worker is still preparing or has failed.

An attach request must be rejected for an empty room because AI agents must not remain in a room without a human participant. A successful attach requires a real LiveKit `AGENT` participant in the target room. A `CreateDispatch` HTTP 200 response is not enough, because LiveKit can persist a dispatch record before a worker accepts the job.

`webmeetAgent` persists dispatch metadata, chat, transcripts, recordings, artifacts, tasks, and decisions. It must not create fake AI participants. Guest users and normal logged-in users can see AI output but cannot attach, control, or finalize agents.

When no human participants remain after explicit leave, stale-presence cleanup, or LiveKit reconciliation, `webmeetAgent` must detach every active LiveKit AI agent dispatch for that room and emit `agent.detached` events with `reason: "no_human_participants"` where the detach helper provides that reason.

LiveKit Cloud and LiveKit Inference are not required or enabled implicitly. Provider credentials for LLM, STT, or TTS must be configured explicitly. Request-time LLM inference inside the worker must go through `achillesAgentLib` helpers.

Scribe agents use the internal `webmeetStt` service through `WEBMEET_STT_URL` and persist transcript segments through `webmeetAgent` with the shared derived `WEBMEET_AGENT_INTERNAL_TOKEN`. Neither value should require manual local setup in supported profiles.

In the production profile, the worker uses host networking to match the production LiveKit host-network topology. The worker uses `WEBMEET_LIVEKIT_AGENT_URL=http://127.0.0.1:7880` for its LiveKit connection, while bridge-resident `webmeetAgent` continues to use `WEBMEET_LIVEKIT_URL=http://host.containers.internal:7880` for control-plane calls. `webmeetAgent` publishes localhost-only prod ports for its proxy and internal API so the host-network worker can persist chat and transcripts without creating a public bypass around Ploinky routing.

## Decisions & Questions

### Question #1: Why require a real LiveKit `AGENT` participant before persistence?

Response:
LiveKit dispatch is asynchronous. Persisting an active WebMeet agent after only `CreateDispatch` would let the WebMeet store claim an AI participant exists even if no worker accepted the job. Waiting for a matching `AGENT` participant makes room presence honest.

### Question #2: Why keep AI worker readiness out of the default WebMeet readiness path?

Response:
The worker has a native dependency tree and optional provider configuration that normal meeting use does not need. WebMeet's base room, guest, media, and recording flows should start even when AI worker setup is unavailable.

### Question #3: Why does scribe persistence use an internal token instead of a public route?

Response:
The scribe worker is an internal runtime component writing transcript segments on behalf of an accepted LiveKit dispatch. The derived internal token lets it reach a narrow internal API without granting browser or guest routes transcript-write authority.

## Conclusion

WebMeet AI remains trustworthy while it uses explicit LiveKit dispatch, confirms real worker participants, keeps optional worker dependencies outside `webmeetAgent`, and persists only verified dispatch and transcript outcomes.
