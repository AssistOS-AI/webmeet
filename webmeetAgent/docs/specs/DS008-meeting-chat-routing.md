---
title: DS008-meeting-chat-routing
summary: Defines WebMeet chat persistence, verified authorship, file-reference autocomplete, and the boundary between room messages and explicit agent workflows.
---

# DS008-meeting-chat-routing

## Introduction

WebMeet chat is a room conversation surface. It persists participant messages and may deliver realtime notifications, but it does not infer provider routing from text that resembles an agent tag.

## Core Content

`webmeet_chat_send` must persist the user's message before a connected browser publishes the corresponding reliable LiveKit data-channel notification. LiveKit provides prompt delivery to connected participants but does not store WebMeet chat history.

Authenticated chat submissions derive authorship from verified invocation identity. Room-scoped guest submissions derive the author from the verified guest scope and stored participant record. Caller-supplied `authorId` or `authorName` values cannot override that identity, and ordinary callers cannot claim a reserved room-agent identity.

Text such as `@open-interpreter list primes` is persisted as ordinary meeting text. WebMeet does not parse arbitrary `@word` tokens into provider calls, research jobs, tasks, or room-agent commands. Agent participation uses an explicit Copilot bridge or a WebMeet room-agent lifecycle with its own authorization, visible state, and administration.

The WebMeet composer may offer file and folder references from Explorer through the host's `search_files` tool. This autocomplete contains workspace references only; it does not present an Agents group or provider suggestions. Known `@file:` references may receive distinct presentation after the message is stored, while other tag-like text remains unchanged.

Ploinky-managed room agents may read authorized room context and call WebMeet tools through their documented lifecycle. Their participation does not change the routing meaning of ordinary participant chat.

## Conclusion

WebMeet chat remains predictable when every message has verified authorship, durable persistence precedes realtime delivery, workspace references stay presentation-only, and agent execution requires an explicit workflow rather than tag inference.
