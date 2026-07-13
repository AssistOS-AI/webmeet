---
id: DS006
title: Ploinky Runtime Invariants
status: implemented
owner: webmeet-team
summary: Captures routing, authentication, guest, secure-wire, sandbox, secret, storage, logging, and documentation invariants for webmeetAgent.
---

# DS006 - Ploinky Runtime Invariants

## Introduction

This specification makes the Ploinky runtime and security invariants local to `webmeetAgent`. Future work from inside this agent directory must not rely on external memory of Ploinky core behavior; the local specs must carry the constraints that affect the agent's implementation and documentation.

The authoritative upstream contracts are Ploinky `docs/specs/DS005-routing-and-web-surfaces.md` and `docs/specs/DS011-security-model.md`. This file restates only the invariants that affect WebMeet.

## Core Content

`webmeetAgent` must treat the Ploinky router as the browser and MCP trust broker. Browser surfaces, first-party MCP calls, delegated MCP calls, uploads, blobs, and manifest-declared HTTP services are expected to enter through the router so route authentication, session handling, invocation minting, and audit behavior can apply. Direct agent ports are implementation details even when bound to localhost.

Executable MCP operations must be authorized by router-minted request JWTs. The launcher/router may derive per-agent request secrets from `PLOINKY_MASTER_KEY`, but the agent runtime must receive only its own `PLOINKY_AGENT_ID`, `PLOINKY_AGENT_SECRET`, and compatibility `PLOINKY_AGENT_PRINCIPAL`. Agents must never receive, derive, or require `PLOINKY_MASTER_KEY` or the legacy `PLOINKY_DERIVED_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

Ploinky-owned generated secrets are resolved by the launcher before agent code runs. Agent-owned generated secrets use `generatedSecret: true` for manifest env entries or `{{generatedSecret:NAME}}` for runtime-resource templates; both are scoped to the current agent identity and ignore operator-supplied values. Shared generated credentials that must be identical across agents use `sharedGeneratedSecret: true` and derive from the source env name. Agents consume the resolved values but do not hold the master derivation key. Agents must not invent random persistent agent secrets or require manual configuration for workspace-owned LiveKit, TURN, OnlyOffice, DPU, webhook, or data-encryption secrets. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. WebMeet domain authorization must use router-minted invocation identity, roles, and scopes. Caller-supplied copies of identity headers must not become authoritative input.

WebMeet must not expose its own internal HTTP API port as a product surface. The browser UI calls WebMeet through the generic Ploinky MCP route. Direct room links use the agent-owned static loader `/<webmeetAgent>/roomLoader.html?roomId=<roomId>` and whitelisted static assets; they are not backed by a WebMeet-specific router bridge or generated server page.

Guest access must remain scoped to a single room. Public room access is exposed through `/<webmeetAgent>/roomLoader.html?roomId=<roomId>`. Ploinky core owns public-protected routing, anonymous token/session handling, and UI/assets whitelisting; WebMeet receives the verified invocation context and authorizes room operations against the room scope.

Ploinky route authentication identifies the caller, but `webmeetAgent` still owns domain authorization. Sensitive actions must check verified user identity, roles, scopes, room id, participant id, workspace path, and local policy before reading or mutating state. Admin-only actions include room creation, rename, archive, AI attach/detach, and other management surfaces.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must resolve relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must reject absolute caller paths, traversal, NUL bytes, and symlink escapes where user input can influence path resolution. Browser responses must not leak host absolute paths.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, LiveKit participant JWTs, API keys, private keys, raw prompts, hidden policy text, internal payloads, SDP, ICE credentials, screenshots, or DOM dumps. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence. Opt-in media diagnostics must identify sensitive data by both field name and content, including serialized or recursively percent-encoded assignments and keys, URL userinfo, TURN/STUN URLs, private-key material, SDP, and ICE candidate lines. Percent decoding must continue to convergence under a strict pass and work bound; exhausting either bound redacts the whole string or key-owned value. Sensitive-shaped strings therefore fail closed while unrelated aggregate context may remain.

`webmeetAgent` must not declare, detect, seed, or consume public network topology. `basic/web-publishing` is the sole provider of `WEBMEET_PUBLIC_LIVEKIT_URL` and `WEBMEET_LIVEKIT_URL`; both manifest entries are non-sensitive and optional at static validation time because config-provider output is applied later, but `scripts/startAgent.sh` must reject either value when it remains empty after provider resolution. WebMeet declares no TURN/STUN topology or credential variables. See DS004 for the policy-only ICE contract.

Agent-local contract:

- Manifest: `manifest.json`.
- Role: Meeting application agent for workspace team rooms and invite-scoped public meetings.
- Authentication: Workspace room operations require authenticated route/MCP context. Public room entry requires a Ploinky public-protected invocation scoped to the target room.
- HTTP service surface: WebMeet does not publish a product HTTP service surface. Browser calls use the generic Ploinky MCP route, and direct room entry uses the whitelisted `roomLoader.html` plus plugin/assets routing owned by Ploinky core.
- Persistent state: Room data lives under `/data`; LiveKit secrets stay server-side.
- Volumes: `.ploinky/data/webmeetAgent/data:/data`.
- Dependencies: `liveKitServerAgent` and `turnServerAgent` are blocking dependencies, and Explorer starts `webmeetAgent` as blocking. Base startup uses Ploinky's shared prepared dependency cache. WebMeet must not add native external AI worker dependencies.
- Network: primary `webmeet-signaling` only. `webmeetAgent` declares no aliases and does not join `webmeet-turn` or `office-publishing`; Ploinky derives its network-scoped DNS name from the canonical agent id.
- Secret handling: `PLOINKY_WEBMEET_MASTER_KEY` is an agent-scoped generated secret. LiveKit API key/secret and `router/MCP invocation identity` are workspace-scoped generated secrets because they are still consumed by the LiveKit media infrastructure agent. `webmeetAgent` declares no TURN credential at all: `liveKitServerAgent` and `turnServerAgent` share the Coturn REST-auth secret, LiveKit mints expiring browser credentials, and Coturn validates them. The remaining shared raw LiveKit credential and the `router/MCP invocation identity` remain a migration pressure: the target is for `liveKitServerAgent` to own raw LiveKit credentials and expose owner-mediated operations, and for `router/MCP invocation identity` to be replaced by router/secure-wire identity.
- Documentation: `docs/index.html` and `docs/specs/matrix.md`.
- Validation: Run proxy/plugin syntax checks and a Ploinky guest invite smoke test for auth or route changes.

Browser realtime refreshes driven by meeting/workspace events are best effort. They must catch transient MCP client resets, session refreshes, and stale-room races without creating unhandled promise rejections or console error loops. Direct user-initiated actions must continue to surface actionable failures through the WebMeet UI.

## Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside the agent spec set?

Response:
Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants local prevents agents from treating router auth, guest mode, direct ports, or invocation headers as bypassable implementation details.

### Question #2: Why is route authentication not enough for WebMeet authorization?

Response:
Ploinky establishes who the caller is and signs the invocation path. `webmeetAgent` knows which room, participant, resource, or AI-control action is safe for that caller. Each operation must therefore enforce local resource policy after reading verified auth context.

### Question #3: Why derive WebMeet secrets instead of storing local development defaults?

Response:
LiveKit, WebMeet encryption, and internal worker calls need stable workspace-owned secrets without committing plaintext defaults or requiring manual setup on a fresh workspace. `generatedSecret: true` is the preferred target for per-agent secrets, but WebMeet encryption is deliberately held on the compatibility derivation until existing payload readability is verified or migrated. The remaining cross-agent shared derivation (LiveKit, internal token) is a legacy exception whose target state is owner-mediated service operations rather than a raw shared credential. TURN no longer follows this pattern in `webmeetAgent` at all: it was retired from this agent's manifest, store context, and startup script; inside `webmeetInfra`, LiveKit and Coturn intentionally share the REST-auth secret while owning credential issuance and validation respectively.

## Conclusion

`webmeetAgent` remains compatible with Ploinky only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest HTTP services, workspace-confined storage, redacted logging, derived secrets, and local domain authorization.
