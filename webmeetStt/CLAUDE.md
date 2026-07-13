# webmeetStt Agent Guide

## Scope

`webmeetStt` owns the self-hosted Faster-Whisper speech-to-text service used by WebMeet scribe agents. It is a Ploinky-managed internal service and must not expose public HTTP routes.

## Rules

- Keep the service on its isolated Ploinky default network. It must not join WebMeet signaling, TURN, or office trust zones and must not declare aliases.
- Store model cache and runtime data under `.ploinky/data/webmeetStt`.
- Do not log raw audio, transcript text, tokens, or request payloads.
- Update `AGENTS.md` and `CLAUDE.md` together so coding agents receive the same local context.
