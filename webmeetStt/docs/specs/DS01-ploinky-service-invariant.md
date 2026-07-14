# DS01 - Ploinky Service Invariant

`webmeetStt` is the Ploinky-managed internal Faster-Whisper service for WebMeet transcript generation. It owns the Python runtime, Faster-Whisper dependency installation, model cache volume, internal port, and readiness.

The service is not a browser surface and must not declare `httpServices`. Its manifest explicitly selects Ploinky `mode: "default"`, which gives it an isolated workspace-owned network with no sibling-agent DNS. It must not join `webmeet-signaling`, `webmeet-turn`, or `office-publishing`, and it declares no aliases. Every profile keeps `WEBMEET_STT_PORT=9000` internal and declares neither `openPorts` nor `additionalServerPort`. Any future WebMeet transcription integration must add an explicit mediated service contract rather than broadening this network boundary or inventing a localhost fallback.

`webmeetStt` is a start-only container, so its manifest declares `health.readiness.script` rather than an explicit TCP protocol that requires a published host route. The root-level `readiness.sh` probe runs inside the container and requires an exact HTTP `200` from `http://127.0.0.1:${WEBMEET_STT_PORT}/healthz`. A direct or blocking launch uses this as fail-closed startup readiness, and the watchdog can reuse it as a warning-oriented health probe. Explorer intentionally enables `webmeetStt no-wait`, so its detached launch does not delay or fail Explorer startup; launch failures remain visible through the no-wait status and log, while subsequent health failures surface through watchdog monitoring without exposing port `9000` across the Ploinky box boundary.

Before transcription, the service can run local DTLN denoise on uploaded 16 kHz PCM WAV chunks. `WEBMEET_STT_DENOISE=dtln` enables the self-hosted path and is the default; `WEBMEET_STT_DENOISE=off` skips it. DTLN failures must be logged briefly and fall back to the original audio so transcript generation remains available.

This denoise stage is for transcript/AI ingestion only. LiveKit room participants are not denoised server-side by `webmeetStt`; human microphone cleanup is handled in the browser before publish.
