---
id: DS007
title: No-Agent-Tag Meeting Chat
status: implemented
owner: webmeet-team
summary: Defines WebMeet chat behavior after inline provider tag dispatch was removed; provider routing belongs outside meeting chat.
---

# DS007 - No-Agent-Tag Meeting Chat

## Introduction

WebMeet chat is a room conversation surface. It must not dispatch provider-looking tags through optional research, Copilot, or LiveKit AI infrastructure just because a user typed an `@word` in the meeting chat composer.

## Core Content

`webmeet_chat_send` must persist the user's chat message and return the appended chat record. Text such as `@open-interpreter list primes` is ordinary meeting chat. It must not call a research relay, create a task, or dispatch a provider.

The durable chat write is authoritative and goes through `webmeetAgent`. A connected browser or LiveKit AI worker may publish a LiveKit reliable data-channel payload after persistence so other connected clients update quickly, but that payload is a realtime hint. LiveKit does not store WebMeet chat history.

Authenticated MCP chat submissions should derive the normal user author identity from invocation auth when available instead of trusting caller-supplied `authorId` and `authorName` fields. Public-protected guest MCP chat derives guest authorship from the room-scoped invocation context and stored participant record.

The `research:` author id prefix is reserved for relay-generated chat messages if a future explicit bridge reintroduces relay output. Normal authenticated callers must not spoof that prefix.

Future meeting-to-agent behavior must be an explicit Copilot bridge or WebMeet meeting-agent workflow. It must not be implemented as inline `@agent` parsing inside WebMeet chat.

The WebMeet IDE chat composer may expose a Ploinky-style `@` autocomplete for generic file/workspace references only. The menu must not expose an `Agents` group or provider suggestion such as `@open-interpreter`. File and folder suggestions may query the Explorer host's `search_files` tool through the WebMeet side of the plugin. Sent messages may render known `@file:` references in bold; arbitrary `@word` tokens remain plain chat text.

LiveKit AI agents have a separate lifecycle. An assistant agent may answer an explicit mention after it is attached as a real LiveKit participant, but that behavior is owned by the worker dispatch contract in DS005 and does not make provider tags in normal chat a routing mechanism.

## Decisions & Questions

### Question #1: Why remove inline provider tag dispatch from meeting chat?

Response:
Meeting chat should not depend on optional provider agents or expose provider-routing semantics to every room participant. Semantic provider routing belongs to explicit Copilot or meeting-agent workflows where authorization, lifecycle, and user expectations are clear.

### Question #2: Why not use LiveKit AI dispatch for arbitrary provider tags?

Response:
LiveKit AI dispatch represents real realtime meeting participants with room lifecycle and presence. Provider tasks such as "use a code interpreter" are request/response jobs selected by a different routing system. Treating every `@word` as a LiveKit dispatch would blur these contracts.

### Question #3: Why keep a WebMeet-owned autocomplete adapter?

Response:
The WebMeet plugin runs inside AssistOSExplorer and the guest shell, not inside Ploinky WebChat. It needs its own generic file-reference autocomplete without embedding the Ploinky webchat runtime or coupling framework modules to WebMeet-specific behavior.

## Conclusion

WebMeet chat remains a room collaboration surface. Provider-looking text is persisted as ordinary chat unless a future explicit bridge changes the contract and updates this specification.
