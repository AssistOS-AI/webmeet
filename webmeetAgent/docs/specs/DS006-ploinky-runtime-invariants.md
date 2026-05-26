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

Executable MCP operations must be authorized by router-minted invocation JWTs. The agent runtime may receive `PLOINKY_DERIVED_MASTER_KEY`, which is the HKDF-derived agent runtime key, but it must never receive or require `PLOINKY_MASTER_KEY`. Code must not invent alternate bearer-token, client-secret, or caller-header authorization paths around the router's secure-wire model.

`PLOINKY_DERIVED_MASTER_KEY` is the mandatory root for Ploinky-owned and agent-owned generated secrets. Any agent secret that is not an external provider or operator credential must be deterministically derived from `PLOINKY_DERIVED_MASTER_KEY` using a domain-separated label for repo, agent, and secret name. The preferred manifest spelling is `generatedSecret: true` for per-agent env entries and `{{generatedSecret:NAME}}` for runtime-resource templates; both derive from the current agent identity and ignore operator-supplied values. The older `derive: "derived-master"` env entries and `{{derivedMasterSecret:NAME}}` runtime-resource templates remain as compatibility paths for explicit shared derivations that must pin a logical repo, agent, or secret name different from the current agent. External third-party credentials remain explicitly configured.

The compact `x-ploinky-auth-info` header is not a secure grant by itself. An HTTP service may trust it only when it arrived through a declared Ploinky HTTP service route. For guest services, `webmeet-public-proxy.mjs` must also validate the router-issued invocation token and expected guest role or scope. Caller-supplied copies of identity headers must not become authoritative input.

The internal WebMeet API port must not be exposed as a product surface. `webmeet-public-proxy.mjs` verifies router invocation identity, injects the derived `WEBMEET_AGENT_INTERNAL_TOKEN` into proxied API requests, and `webmeet-api.mjs` rejects non-health requests that do not carry that internal token.

Guest access must remain scoped to the route shape declared by `manifest.json`. `webmeetAgent` must not set manifest-level `guest: true`; public meeting access is exposed only through the `/public-services/webmeet/` HTTP service with `auth: "guest"`, `guestScope: "webmeet-public-service"`, and `forceGuest: true`.

Ploinky route authentication identifies the caller, but `webmeetAgent` still owns domain authorization. Sensitive actions must check verified user identity, roles, scopes, room/meeting id, participant id, workspace path, and local policy before reading or mutating state. Admin-only actions include room creation, rename, delete, AI attach/detach, recording start/stop, administrative transcript/artifact reads, and other management surfaces.

Runtime isolation is defense in depth, not a hostile multi-tenant guarantee. Containers, bubblewrap, and Seatbelt reduce host exposure, but enabled agent code remains trusted operator-controlled code inside one workspace. Manifest volumes, runtime resources, lifecycle hooks, and network access are intentional grants and must be reviewed as part of the agent contract.

File and static-content handling must stay workspace-confined. Paths must resolve relative to the workspace root, agent root, configured data directory, or explicit runtime volume. Code must reject absolute caller paths, traversal, NUL bytes, and symlink escapes where user input can influence path resolution. Browser responses must not leak host absolute paths.

Logs and user-facing errors must not expose secrets, cookies, bearer tokens, invocation JWTs, LiveKit participant JWTs, API keys, raw prompts, hidden policy text, internal payloads, SDP, ICE credentials, screenshots, or DOM dumps. Detailed diagnostics belong behind explicit debug modes and must still redact sensitive values before persistence.

Agent-local contract:

- Manifest: `manifest.json`.
- Role: Meeting application agent for workspace team rooms and invite-scoped public meetings.
- Authentication: Workspace room operations require authenticated route/MCP context. Public meeting entry is limited to the manifest-declared guest public service with scoped forced guest sessions.
- HTTP service surface: Protected `/services/webmeet/` and forced-guest `/public-services/webmeet/` prefixes rewrite to the internal `/api/` surface through the WebMeet proxy. The internal API port is not published by the production manifest.
- Persistent state: Meeting data lives under `/data`; recordings live under `/data/recordings`; LiveKit secrets stay server-side.
- Volumes: `.ploinky/data/webmeetAgent/data:/data` and `.ploinky/data/webmeet/recordings:/data/recordings`.
- Dependencies: Base startup uses Ploinky's shared prepared dependency cache. Optional native LiveKit worker dependencies belong to `webmeetLivekitAiAgent`.
- Secret handling: `PLOINKY_WEBMEET_MASTER_KEY` remains on `derive: "derived-master"` until a dedicated encrypted-data migration verifies that switching to `generatedSecret: true` preserves the same value or safely rewraps existing meeting records. LiveKit API key/secret, TURN password, and `WEBMEET_AGENT_INTERNAL_TOKEN` also remain as explicit `derive: "derived-master"` shared derivations because they are consumed by sibling agents (`liveKitServerAgent`, `webmeetLivekitAiAgent`). These shared derivations are legacy exceptions; the target migration is for `liveKitServerAgent` to own raw LiveKit and TURN credentials and expose owner-mediated operations, and for `WEBMEET_AGENT_INTERNAL_TOKEN` to be replaced by router/secure-wire identity.
- Documentation: `docs/index.html` and `docs/specs/matrix.md`.
- Validation: Run proxy/plugin syntax checks and a Ploinky guest invite smoke test for auth or route changes.

Browser realtime refreshes driven by meeting/workspace events are best effort. They must catch transient MCP client resets, session refreshes, and stale-room races without creating unhandled promise rejections or console error loops. Direct user-initiated actions must continue to surface actionable failures through the WebMeet UI.

## Decisions & Questions

### Question #1: Why duplicate Ploinky invariants inside the agent spec set?

Response:
Coding work often starts from an individual agent directory, where only local guidance may be read before changes are made. Keeping these Ploinky invariants local prevents agents from treating router auth, guest mode, direct ports, or invocation headers as bypassable implementation details.

### Question #2: Why is route authentication not enough for WebMeet authorization?

Response:
Ploinky establishes who the caller is and signs the invocation path. `webmeetAgent` knows which room, participant, artifact, transcript, recording, or AI-control action is safe for that caller. Each operation must therefore enforce local resource policy after reading verified auth context.

### Question #3: Why derive WebMeet secrets instead of storing local development defaults?

Response:
LiveKit, TURN, WebMeet encryption, and internal worker calls need stable workspace-owned secrets without committing plaintext defaults or requiring manual setup on a fresh workspace. `generatedSecret: true` is the preferred target for per-agent secrets, but WebMeet encryption is deliberately held on the compatibility derivation until existing payload readability is verified or migrated. The remaining cross-agent shared derivations (LiveKit, TURN, internal token) are legacy exceptions whose target state is owner-mediated service operations rather than raw shared credentials.

## Conclusion

`webmeetAgent` remains compatible with Ploinky only while it preserves router-mediated entry, secure-wire invocation, scoped guest behavior, explicit manifest HTTP services, workspace-confined storage, redacted logging, derived secrets, and local domain authorization.
