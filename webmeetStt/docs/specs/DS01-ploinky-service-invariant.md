# DS01 - Ploinky Service Invariant

`webmeetStt` is the Ploinky-managed internal Faster-Whisper service for WebMeet transcript generation. It owns the Python runtime, Faster-Whisper dependency installation, model cache volume, internal port, and readiness.

The service is not a browser surface and must not declare a Router HTTP route. Its
network contract is the strict v5 bridge form with one primary logical
attachment named `webmeet`; legacy `network.name` and `network.aliases` are
invalid. Ploinky derives the effective instance alias and keeps the service on
that isolated bridge. Readiness runs inside the container and verifies the
loopback `/healthz` endpoint, so it does not require a Router target or a
private port mapping. No current WebMeet consumer is confirmed after removal
of the prior LiveKit AI worker, so retaining or removing this dependency is a
separate product decision; this networking hard cut does not invent a new
consumer or expose STT publicly.

Before transcription, the service can run local DTLN denoise on uploaded 16 kHz PCM WAV chunks. `WEBMEET_STT_DENOISE=dtln` enables the self-hosted path and is the default; `WEBMEET_STT_DENOISE=off` skips it. DTLN failures must be logged briefly and fall back to the original audio so transcript generation remains available.

This denoise stage is for transcript/AI ingestion only. LiveKit room participants are not denoised server-side by `webmeetStt`; human microphone cleanup is handled in the browser before publish.

The pinned Python environment is built atomically under the persistent
`.ploinky/data/webmeetStt` volume and reused while its dependency revision is
unchanged. A cold install gets three bounded attempts and streams installer
output into the container log; startup must never hide the only diagnostic in
container-local temporary files that disappear during exact failure cleanup.
