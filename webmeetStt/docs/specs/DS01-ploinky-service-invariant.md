# DS01 - Ploinky Service Invariant

`webmeetStt` is the Ploinky-managed internal Faster-Whisper service for WebMeet transcript generation. It owns the Python runtime, Faster-Whisper dependency installation, model cache volume, internal port, and readiness.

The service is not a browser surface and must not declare `httpServices`. WebMeet reaches it only through the internal `webmeet` network alias `webmeetStt`.

Before transcription, the service can run local DTLN denoise on uploaded 16 kHz PCM WAV chunks. `WEBMEET_STT_DENOISE=dtln` enables the self-hosted path and is the default; `WEBMEET_STT_DENOISE=off` skips it. DTLN failures must be logged briefly and fall back to the original audio so transcript generation remains available.

This denoise stage is for transcript/AI ingestion only. LiveKit room participants are not denoised server-side by `webmeetStt`; human microphone cleanup is handled in the browser before publish.
