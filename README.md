# webmeet

Ploinky agents for WebMeet, the room-based meeting application. Each top-level directory is one agent (`<agent>/manifest.json`), installed by Ploinky as the `webmeet` repository, so agent identities are `agent:webmeet/<agent>` and container names start with `ploinky_webmeet_<agent>_`.

| Agent | Role | Enabled by |
| --- | --- | --- |
| `webmeetAgent` | WebMeet rooms, LiveKit token issuance, chat, Blackboard state | Explorer manifest: `webmeet/webmeetAgent global no-wait` |
| `liveKitServerAgent` | LiveKit, Redis and Egress media runtime (fixed in-Box UDP 7882) | Explorer manifest: `webmeet/liveKitServerAgent no-wait`; `webmeetAgent` and `webmeetScribeAgent` enable it as `liveKitServerAgent` |
| `webmeetScribeAgent` | Optional text-only Meeting Secretary | Enabled on demand from WebMeet room settings (Meeting Notes); not in the default enable list |
| `webmeetStt` | Optional speech-to-text service | Optional; not in the default enable list |
| `moderator` | Example moderator agent kept from the original repository | Not enabled by default |

Consumers register this repository through their manifest `repos{}` entry `"webmeet": "https://github.com/AssistOS-AI/webmeet.git"` and enable agents as `webmeet/<agent>`.

Some `webmeetAgent` unit tests import AssistOSExplorer code. Check out AssistOSExplorer next to this repository or set `EXPLORER_ROOT`; the tests fail when it is missing. See [AGENTS.md](AGENTS.md) for test commands. Documentation starts at [docs/index.html](docs/index.html).
