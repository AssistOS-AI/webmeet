# DS01 - Ploinky Service Invariant

`webmeetStt` is the Ploinky-managed internal Faster-Whisper service for WebMeet transcript generation. It owns the Python runtime, Faster-Whisper dependency installation, model cache volume, internal port, and readiness.

The service is not a browser surface and must not declare `httpServices`. WebMeet reaches it only through the internal `webmeet` network alias `webmeetStt`.
