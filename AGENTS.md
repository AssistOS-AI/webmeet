# webmeet

Ploinky agents for WebMeet. Origin: `https://github.com/AssistOS-AI/webmeet.git`. Agent identities are `agent:webmeet/<agent>`; container names start with `ploinky_webmeet_<agent>_`. `moderator/` is the example agent that this repository contained originally; keep it documented and unchanged unless asked.

`AGENTS.md` is the single instruction file in this repository, at the root and in each agent folder. Do not add `CLAUDE.md` files.

## Mandatory Reading Order

1. The workspace root `AGENTS.md` for workspace conventions, then this file and the `AGENTS.md` of the agent you are editing.
2. The agent's `docs/index.html`, `docs/wiki.html` and `docs/specs/matrix.md`, plus `docs/specs/DS001-coding-style.md` where present.
3. Where an agent's `AGENTS.md` refers to the parent `../AGENTS.md`, use this file together with the agent's own coding-style spec.

## Agents, tests and enablement

Run each command from the agent directory. Node.js 20 or later.

| Agent | Test command | Who enables it |
| --- | --- | --- |
| `webmeetAgent` | `EXPLORER_ROOT=<AssistOSExplorer checkout> node --import ../test-support/register-explorer-root.mjs --test tests/unit/*.test.mjs` | Disabled by default; an administrator enables it from Explorer Marketplace, or opening the WebMeet toolbar plugin enables it on demand. Its manifest pins `enableModes: ["global"]` |
| `liveKitServerAgent` | `node --test tests/*.test.mjs` | Not default-enabled; `webmeetAgent` (`liveKitServerAgent no-wait`) and `webmeetScribeAgent` (`liveKitServerAgent`) enable it |
| `webmeetScribeAgent` | `node --test tests/*.test.mjs` | On demand from WebMeet room settings; not default-enabled |
| `webmeetStt` | `PYTHONPATH=. python3 -m unittest discover -s tests` | Optional; not default-enabled |
| `moderator` | none | Not enabled by default |

## Cross-repository rules

- Tests that import AssistOSExplorer code use `test-support/explorer-root.mjs`. It resolves `EXPLORER_ROOT` (default `../AssistOSExplorer` next to this repository) and throws when the checkout is missing. Never skip these tests.
- `test-support/register-explorer-root.mjs` maps the absolute browser URLs `/explorer/...` to that checkout under Node. Preload it with `--import`, as in the `webmeetAgent` command above, whenever tests load browser plugin sources.
- Browser-served plugin files import Explorer code through absolute `/explorer/...` URLs, never relative `../../../explorer/...` paths.
- Fixtures that mint grants use the sibling `../ploinky` checkout and fail when it is missing.
- `MEETING_SECRETARY_PRINCIPAL` in `webmeetAgent/lib/meetingNotes/service.mjs` is `agent:webmeet/webmeetScribeAgent`. It authorizes meeting-notes writes and must equal the Scribe agent's real identity.
- Each agent's `docs/partials-loader.js` imports `../../docs/documentation-breadcrumb.js`; keep `docs/documentation-breadcrumb.js` at the repository root.
- `liveKitServerAgent` always advertises in-Box UDP 7882; host ports are chosen with the Ploinky global `--port` and `--udp-port` flags.
