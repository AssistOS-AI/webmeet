---
id: DS11
title: No-Agent-Tag Meeting Chat
status: implemented
owner: webmeet-agent-team
summary: Defines WebMeet chat behavior after @research tag dispatch was removed; provider routing belongs to AchillesCLI Copilot.
---

# DS11 - No-Agent-Tag Meeting Chat

## Introduction

WebMeet chat is a meeting transcript surface. It no longer dispatches
`@research` tags through `copilot-agents`; provider routing belongs to
AchillesCLI Copilot semantic routing.

## Core Content

`webmeet_chat_send` must persist the user's chat message and return the
appended chat record. Text such as `@open-interpreter list primes` is ordinary
meeting chat. It must not call `researchRelay`, must not append an agent-kind
research result, and must not create a task artifact.

The `research:` author id prefix is reserved for relay-generated chat messages.
Authenticated MCP chat submissions must derive the normal user author identity
from invocation auth when it is available, instead of trusting caller-supplied
`authorId` and `authorName` fields. Public guest HTTP chat keeps its separate
guest-token participant validation path.

Future meeting-to-agent behavior must be an explicit Copilot bridge or
meeting-agent workflow. It must not be implemented as inline `@agent` parsing
inside WebMeet chat.

The WebMeet IDE chat composer exposes a Ploinky-style `@` autocomplete that is
visually integrated into the WebMeet chat panel for generic file/workspace
references only. The menu must not expose an `Agents` group or
`@open-interpreter` suggestion. The `Files and folders` group queries the
Explorer host's `search_files` tool, mirroring the Ploinky picker without
exposing provider secrets to the browser. Sent WebMeet chat messages may render
generic `@file:` references in bold. Arbitrary `@word` tokens remain plain
chat text.

## Decisions & Questions

### Question #1: Why remove inline research tag dispatch?

Response:
WebMeet is a meeting chat and transcript surface. Inline provider dispatch made
meeting chat depend on optional research-agent deployment and visible provider
tokens. AchillesCLI Copilot now owns semantic provider routing.

### Question #2: Why not use LiveKit AI dispatch for these tasks?

Response:
Provider tasks are request/response jobs selected by Copilot routing. LiveKit
AI dispatch represents real realtime meeting participants and has a separate
lifecycle.

### Question #3: Why reserve `research:` author ids?

Response:
Relay result messages are rendered in the same chat stream as user messages.
Reserving the prefix prevents authenticated tool callers from spoofing research
agent output while preserving normal participant ids for public guest chat.

### Question #4: Why keep a WebMeet-owned autocomplete adapter?

Response:
Ploinky's composer autocomplete is bound to its `.wa-composer` ancestor and
theme variables, which do not exist in the AssistOSExplorer host that loads
the WebMeet IDE plugin. The plugin must not embed the Ploinky webchat runtime
or couple Ploinky framework modules to WebMeet-specific behavior, so WebMeet
ships its own adapter for generic file/workspace references while keeping the
Explorer `search_files` tool on the WebMeet side.

## Conclusion

WebMeet treats provider-looking tags as ordinary chat text and preserves
meeting chat persistence. Provider routing belongs to AchillesCLI Copilot.
