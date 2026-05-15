---
id: DS09
title: Ploinky Runtime Invariants
status: implemented
owner: webmeet-team
summary: Captures the Ploinky routing, authentication, guest, secure-wire, sandbox, and documentation invariants that must remain in local context when changing this agent.
---

# DS09 - Ploinky Runtime Invariants

## Introduction

This specification makes the Ploinky runtime and security invariants local to `webmeetAgent`. Future work from inside this agent directory must not rely on external memory of Ploinky core behavior; the local specs must carry the same high-level constraints that Ploinky defines in its routing and security model.

The authoritative upstream contracts are Ploinky `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/specs/DS011-security-model.md`. This file restates only the invariants that affect this agent's implementation and documentation.

## Core Content

`webmeetAgent` must treat the Ploinky router as the browser and MCP trust broker. Browser surfaces, first-party MCP calls, delegated MCP calls, uploads, blobs, and manifest-declared HTTP services are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when they are bound to localhost.

Executable MCP operations must be authorized by router-minted invocation JWTs. The agent runtime may receive `PLOINKY_DERIVED_MASTER_KEY`, which is the HKDF-derived agent runtime key, but it must never receive or require `PLOINKY_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

`PLOINKY_DERIVED_MASTER_KEY` is the mandatory root for Ploinky-owned and agent-owned generated secrets. Any agent secret that is not an external provider or operator credential must be deterministically derived from `PLOINKY_DERIVED_MASTER_KEY` using a domain-separated derivation label for the repo, agent, and secret name, then injected through manifest `derive: "derived-master"` env entries, `{{derivedMasterSecret:...}}` runtime resources, or an equivalent documented runtime helper. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned LiveKit, TURN, OnlyOffice, DPU, recording, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. Any HTTP service that receives that header must trust it only when it arrived through a declared Ploinky HTTP service route and, for guest services, only after validating the router-issued invocation token and the expected guest role or scope. Caller-supplied copies of identity headers must be rejected as authoritative input.

Guest access must remain scoped to the route shape declared by the owning manifest. Manifest-level `guest: true` exposes the agent as a normal guest agent and should still enforce limitations from `usr.roles`. An `httpServices` entry with `auth: "guest"` exposes only the declared HTTP prefix; `forceGuest: true` must ignore any existing workspace login and mint a service-scoped guest session. Product-specific public paths must be declared in the agent manifest rather than hard-coded in Ploinky core.

Agent code must enforce its own domain authorization. Ploinky route authentication identifies the caller and signs the invocation, but it does not grant every domain operation. Sensitive actions must check the verified user, roles, scopes, target resource, workspace path, and agent-local policy before reading or mutating state.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must be resolved relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must not assume host-specific absolute paths, follow symlink escapes, or place secrets in static roots, plugin assets, HTML documentation, logs, transcripts, screenshots, or test fixtures.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, API keys, raw prompts, hidden policy text, or internal payloads. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Browser realtime refreshes driven by meeting/workspace server-sent events are best-effort. They must catch transient MCP client resets, session refreshes, and stale-room races without creating unhandled promise rejections or console error loops. Direct user-initiated actions must continue to surface actionable failures through the WebMeet UI.

Agent-local contract:

- Manifest: `webmeetAgent/manifest.json`
- Role: Meeting application agent for workspace team rooms and invite-scoped guest rooms.
- Authentication: Workspace room operations require authenticated route/MCP context; guest room entry is limited to the manifest-declared public service with scoped forced guest sessions. Manifest guest: none.
- HTTP service surface: Declares `/public-services/webmeet/` -> `/api/` with `auth: "guest"`, `guestScope: "webmeet-public-service"`, and `forceGuest: true`. Manifest httpServices: {"externalPrefix":"/public-services/webmeet/","internalPrefix":"/api/","auth":"guest","guestScope":"webmeet-public-service","forceGuest":true,"notFoundMessage":"WebMeet route not found."}.
- Persistent state: Meeting data lives under `/data`; recordings live under `/data/recordings`; LiveKit secrets stay server-side. Manifest volumes must use `.ploinky` host paths: {".ploinky/data/webmeetAgent/data":"/data",".ploinky/data/webmeet/recordings":"/data/recordings"}.
- Dependencies: Base WebMeet startup must use only Ploinky's shared prepared dependency cache and must not declare a `webmeetAgent/package.json` that forces an agent-specific npm install during Explorer startup. The optional LiveKit AI worker is owned by the separate `webmeetLivekitAiAgent` Ploinky agent. Its native LiveKit worker dependencies must be prepared under `webmeetLivekitAiAgent`, never inside the long-lived `webmeetAgent` service container.
- Secret handling: `PLOINKY_WEBMEET_MASTER_KEY` is the WebMeet data-encryption key for meeting payload DEK wrapping and must be derived from `PLOINKY_DERIVED_MASTER_KEY` through manifest `derive: "derived-master"`. New payloads must not use `PLOINKY_DERIVED_MASTER_KEY` directly; a legacy unwrap path may exist only to migrate old records into the dedicated WebMeet key. `WEBMEET_AGENT_INTERNAL_TOKEN` must also be manifest-derived and shared only with `webmeetLivekitAiAgent` for internal transcript writes.
- Documentation: `docs/index.html`
- Validation: Run WebMeet proxy/plugin syntax checks and a Ploinky guest invite smoke test for auth or route changes.

## Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside every agent spec set?

Response:
Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants in the local specification set prevents agents from accidentally treating router auth, guest mode, direct ports, or invocation headers as agent-specific implementation details that can be bypassed.

### Question #2: Why is route authentication not enough for domain authorization?

Response:
Ploinky establishes who the caller is and signs the invocation path, but domain ownership remains inside the agent. The agent knows which files, records, rooms, leads, secrets, repositories, media objects, or infrastructure controls are safe for that caller. Each agent must therefore enforce its own resource policy after reading verified auth context.

### Question #3: Why is the LiveKit AI worker a separate agent?

Response:
The WebMeet API, public proxy, MCP tools, room state, chat, camera, screen share, TURN, LiveKit server, and recording flows do not require the self-hosted AI worker package. The worker package pulls native LiveKit runtime assets and a large transitive dependency tree, so making it part of default Explorer startup can block fresh Ubuntu installs before the meeting service is usable. Keeping it in `webmeetLivekitAiAgent` preserves a lightweight base start while still letting operators opt in to real LiveKit AI participants.

## Conclusion

`webmeetAgent` remains compatible with Ploinky only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest-declared HTTP services, workspace-confined storage, redacted logging, and local domain authorization. Any source change that affects these contracts must update this specification, the local docs, and the local guide files in the same change set.
