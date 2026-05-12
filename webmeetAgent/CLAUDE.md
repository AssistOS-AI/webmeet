# webmeetAgent Agent Guide

## Scope

webmeetAgent owns WebMeet rooms, LiveKit token issuance, AI dispatch metadata, meeting artifacts, the WebMeet IDE plugin, and the public guest invite service.

## Mandatory Reading Order

1. Read the nearest parent `AGENTS.md` for workspace-wide rules.
2. Read `docs/index.html` for the local documentation entry point.
3. Read `docs/specs/matrix.md` and the relevant local DS files before changing behavior.
4. Read `docs/specs/DS09-ploinky-runtime-invariants.md` before touching auth, routing, guest access, MCP, HTTP services, files, logs, or runtime configuration.
5. Read `../AGENTS.md` for coding style, module structure, and test-organization rules when that file exists; otherwise inherit the parent repository coding-style authority.

## Current Skill Catalog

- No local skill catalog is declared for this agent.

## Repository Rules

- The DS specifications are the source of truth for local contracts and invariants.
- When source code changes behavior, interfaces, architecture, workflows, security boundaries, or runtime configuration, update both the HTML documentation and the DS specifications.
- Keep DS numbering gap-free within any newly initialized GAMP spec set. Preserve existing local numbering conventions unless a migration updates all links in the same change.
- All documentation, specifications, and code comments must be written in English.
- Do not add imported-skill DS files or skill pages to a downstream host project's docs tree.
- Keep Ploinky runtime invariants in local context: router-mediated entry, secure-wire invocation JWTs, scoped guest mode, manifest-declared HTTP services, workspace-confined paths, and redacted logs.
- Never add AI/coding-agent attribution to commits, release notes, changelogs, generated metadata, comments, or documentation.
- Update `AGENTS.md` and `CLAUDE.md` together so coding agents receive the same local context.

## Runtime Defaults

Runs `scripts/startAgent.sh`, the WebMeet API, public proxy, and AgentServer in `node:20` on the `webmeet` network. The optional self-hosted LiveKit AI worker is owned by the separate `webmeetLivekitAiAgent` Ploinky agent.

## Key Paths

- `manifest.json`
- `docs/specs/DS09-ploinky-runtime-invariants.md`
- `server/`
- `lib/`
- `IDE-plugins/`
- `tools/`

## Validation

Run the narrowest relevant check after edits, then broaden when touching shared behavior:

- `node --check server/webmeet-public-proxy.mjs`
- `node --check IDE-plugins/webmeet-tool-button/webmeet-tool-button.js`
