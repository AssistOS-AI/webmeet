# Specification Matrix

Generated from DS frontmatter. Edit the DS files and rerun the matrix generator instead of editing this file manually.

| Specification | Title | Status | Owner | Summary |
| --- | --- | --- | --- | --- |
| [DS000](specsLoader.html?spec=DS000-vision.md) | WebMeet Agent Vision | [[status:implemented]] | webmeet-team | Defines webmeetAgent as the WebMeet application control plane and keeps media, Ploinky room-agent, STT, and infrastructure responsibilities separate. |
| [DS001](specsLoader.html?spec=DS001-coding-style.md) | Coding Style | [[status:implemented]] | webmeet-team | Defines local source layout, documentation, test, validation, and runtime style for webmeetAgent. |
| [DS002](specsLoader.html?spec=DS002-room-state-and-access.md) | Room State And Access | [[status:implemented]] | webmeet-team | Defines WebMeet room records, team and guest room behavior, durable storage, encryption, and roomId-scoped access checks. |
| [DS003](specsLoader.html?spec=DS003-application-runtime-and-events.md) | Application Runtime And Events | [[status:implemented]] | webmeet-team | Defines the WebMeet MCP tools, browser shells, event encoding, chat persistence, resources, Ploinky room-agent metadata, and avatar rendering boundaries. |
| [DS004](specsLoader.html?spec=DS004-livekit-media-runtime.md) | LiveKit Media Runtime | [[status:partially-implemented-(rootless-private-router-reachability-blocked)]] | webmeet-team | Defines topology-resolved signaling, private Twirp assertions, external relay credentials, reconnect, release gates, and the current fail-closed reachability boundary. |
| [DS005](specsLoader.html?spec=DS005-ploinky-room-agents.md) | Ploinky Room Agents and RoboTeam | [[status:implemented]] | webmeet-team | Defines RoboTeam as a Ploinky-managed WebMeet room agent, not a LiveKit agent worker. |
| [DS006](specsLoader.html?spec=DS006-ploinky-runtime-invariants.md) | Ploinky Runtime Invariants | [[status:partially-implemented-(rootless-private-router-reachability-blocked)]] | webmeet-team | Captures WebMeet's runtime-v5 routing, private-service, security, and fail-closed rootless reachability invariants. |
| [DS007](specsLoader.html?spec=DS007-no-agent-tag-meeting-chat.md) | No-Agent-Tag Meeting Chat | [[status:implemented]] | webmeet-team | Defines WebMeet chat behavior after inline provider tag dispatch was removed; provider routing belongs outside meeting chat. |
| [DS008](specsLoader.html?spec=DS008-scripta-robo-collaboration.md) | SCRIPTA Robo Collaboration | [[status:implemented]] | webmeet-team | Defines workspace-backed SCRIPTA documents, the singleton document widget, multilingual RoboTeam events, voting, and guest-safe projections. |
| [DS009](specsLoader.html?spec=DS009-blackboard-agentic-diagrams.md) | Blackboard Agentic Diagrams | [[status:implemented]] | webmeet-team | Defines the shared multi-zone Blackboard workspace, global atomic history, canonical commands, semantic focus, cross-zone transfers, and agentic diagrams. |
