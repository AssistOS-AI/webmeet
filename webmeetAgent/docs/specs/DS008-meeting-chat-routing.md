---
title: DS008-meeting-chat-routing
summary: Defines WebMeet chat persistence, verified authorship, file-reference autocomplete, and the boundary between room messages and explicit agent workflows.
---

# DS008-meeting-chat-routing

## Introduction

[WebMeet](wiki.html#definition-webmeetagent) chat is a room conversation surface. It persists participant messages and may deliver realtime notifications, but it does not infer provider routing from text that resembles an agent tag.

## Core Content

`webmeet_chat_send` must persist the user's message before a connected browser publishes the corresponding reliable [LiveKit](wiki.html#definition-livekit) data-channel notification. [LiveKit](wiki.html#definition-livekit) provides prompt delivery to connected participants but does not store [WebMeet](wiki.html#definition-webmeetagent) chat history.

Authenticated chat submissions derive authorship from verified invocation identity. The registered `webmeet_chat_send` schema and browser caller do not send `authorId` or `authorName`, and ordinary callers cannot claim a reserved room-agent identity. Guest chat uses the separate `webmeet_chat_send_guest` contract, which requires the joined participant identity and verifies the exact router-issued room scope, active room state, current participant membership, and stored guest-session owner inside the serialized append mutation before deriving authorship from the participant record. The browser cannot select a guest author by supplying author fields, and a participant removed before the append mutation cannot persist another message.

The stored `authorName` of an authenticated message follows one display-name precedence, shared by chat sends, event-command audit messages, blackboard attachment messages, room archive records and the join fallback name: the verified `displayName` (the Router-signed actor display name on direct calls, `usr.displayName` on delegated calls), then `name`, then a `username` that differs from the raw user id, then `email`, then the calling agent's name, and finally `Participant`. A raw user id such as `USER.3` is never shown as a name, although `authorId` keeps the id. The display name is presentation only: administrator checks never read it, so a user-chosen name such as `admin` grants nothing. Blackboard attachment messages from authenticated callers use the same name (or `Participant`), never the stored member name; only guest callers (no verified user identity) use the joined participant's display name. Room archive records store the same name, or an empty string when none exists so the browser shows its generic administrator wording.

Text such as `@open-interpreter list primes` is persisted as ordinary meeting text. [WebMeet](wiki.html#definition-webmeetagent) does not parse arbitrary `@word` tokens into provider calls, research jobs, tasks, or room-agent commands. Agent participation uses the explicit [Ploinky](wiki.html#definition-ploinky) room-agent lifecycle and `webmeet_event_command`, with their own authorization, visible state, and administration.

The [WebMeet](wiki.html#definition-webmeetagent) composer may offer file and folder references from Explorer through the host's `search_files` tool. This autocomplete contains workspace references only; it does not present an Agents group or provider suggestions. Known `@file:` references may receive distinct presentation after the message is stored, while other tag-like text remains unchanged.

Autocomplete requests `includeKind: true` and reads each result's path and file/folder kind from that single search response. It must not issue a separate metadata request for every suggestion: that burst can queue the browser mutation proof needed to send an ordinary message. Untyped or malformed entries are omitted without additional network calls.

Ploinky-managed room agents may read authorized room context and call [WebMeet](wiki.html#definition-webmeetagent) tools through their documented lifecycle. Their participation does not change the routing meaning of ordinary participant chat.

[WebMeet](wiki.html#definition-webmeetagent) chat remains predictable when every message has verified authorship, durable persistence precedes realtime delivery, workspace references stay presentation-only, and agent execution requires an explicit workflow rather than tag inference.
