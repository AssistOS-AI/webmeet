---
id: DS001
title: Coding Style
status: implemented
owner: webmeet-team
summary: Defines local source layout, documentation, test, validation, and runtime style for webmeetAgent.
---

# DS001 - Coding Style

## Introduction

This specification is the local coding-style authority for `webmeetAgent`. It extends the AssistOSExplorer repository conventions with the source layout, validation expectations, and documentation rules needed by the WebMeet application agent.

## Core Content

`webmeetAgent` uses Node.js ES modules. JavaScript files should follow the surrounding style: four-space indentation, `async`/`await`, native Node APIs where practical, camelCase filenames, and small modules kept beside related logic. Shell scripts must remain portable for the container image that runs them and should fail early on missing required runtime configuration.

The local source layout is contract-bearing:

| Path | Purpose |
| --- | --- |
| `manifest.json` | Ploinky agent command, network, dependency edges, volumes, HTTP services, and profile env. |
| `scripts/startAgent.sh` | Starts `webmeet-api.mjs`, the MCP AgentServer, and `webmeet-public-proxy.mjs`. |
| `server/` | HTTP API, public/protected proxy, AxiFace guest assets, and runtime validation. |
| `lib/` | Store, crypto, event append files, secrets helpers, and workspace path resolution. |
| `tools/` | MCP tool dispatcher and shell entrypoint. |
| `IDE-plugins/webmeet-tool-button/` | Explorer and guest WebMeet browser UI, LiveKit client integration, media settings, participant cards, and local vendored assets. |
| `tests/unit/` | Focused regression tests for auth routing, events, media controls, runtime APIs, and UI service helpers. |
| `docs/specs/` | Authoritative DS contracts. |

Documentation, specifications, and comments must be written in English. Any source change that affects behavior, interfaces, architecture, security boundaries, route shape, storage, runtime configuration, or validation must update the relevant DS files and the local HTML documentation in the same change set.

`webmeetAgent` must avoid dependency creep in the base meeting service. There is intentionally no `webmeetAgent/package.json` for the optional LiveKit AI worker dependency tree. Native LiveKit Agents dependencies belong to `webmeetLivekitAiAgent/package.json`, and `webmeetAgent/scripts/startAgent.sh` must not run npm install or import `@livekit/agents`.

All request-time LLM inference must go through `achillesAgentLib` helpers, not direct provider HTTP. Optional AI participant logic belongs to `webmeetLivekitAiAgent`; meeting chat must not introduce inline provider dispatch.

Runtime paths must be derived from `PLOINKY_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `PLOINKY_CWD`, `ASSISTOS_FS_ROOT`, the configured WebMeet data directory, the agent root, or declared volumes. Source must not hardcode workstation-specific absolute paths or expose host paths in browser responses.

Validation should start with the narrowest check that covers the edited surface. Useful local checks include:

- `node --check server/webmeet-api.mjs`
- `node --check server/webmeet-public-proxy.mjs`
- `node --check server/validate-runtime.mjs`
- `node --check tools/webmeet_tool.mjs`
- `node --check IDE-plugins/webmeet-tool-button/webmeet-tool-button.js`
- `node --test tests/unit/*.test.mjs` when behavior or browser-service helpers change.

Auth, guest-route, LiveKit token, recording, or runtime topology changes also require a Ploinky smoke path that starts WebMeet through Explorer or a clear note explaining why that runtime check was not run.

## Decisions & Questions

### Question #1: Why keep `DS001-coding-style.md` local when AssistOSExplorer already defines coding conventions?

Response:
The parent conventions define the shared Explorer baseline. `webmeetAgent` adds local constraints around optional LiveKit worker dependencies, manifest-declared guest routes, browser-vendored media assets, and validation commands. Future edits from this directory need those rules without searching across the workspace.

### Question #2: Why is dependency ownership part of coding style?

Response:
Dependency placement changes startup behavior. Putting the LiveKit Agents worker dependency tree into `webmeetAgent` would make normal rooms and guest invites depend on optional native AI-worker setup. The source-layout rule prevents a local implementation detail from becoming a runtime availability regression.

## Conclusion

`webmeetAgent` code remains maintainable while it follows the existing ES module style, keeps runtime responsibilities in their established directories, updates DS contracts with behavior changes, and validates the exact surface being changed.
