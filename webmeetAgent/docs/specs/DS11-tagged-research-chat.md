---
id: DS11
title: Tagged Research Chat
status: implemented
owner: webmeet-agent-team
summary: Defines how WebMeet chat dispatches @research tags through copilot-agents without simulating LiveKit participants.
---

# DS11 - Tagged Research Chat

## Introduction

WebMeet chat can dispatch tagged research tasks through the `copilot-agents`
relay when that relay is deployed in the Ploinky workspace.

## Core Content

`webmeet_chat_send` must persist the user's chat message first. If the message
contains a configured research tag such as `@open-interpreter`, the tool may
call the configured relay agent and submit tool through Ploinky delegated MCP
using the current invocation token. The default WebMeet configuration mirrors
the Copilot WebChat tag-relay launch contract: `WEBMEET_RESEARCH_TAGS=1`,
`WEBMEET_TAG_RELAY_AGENT=researchRelay`,
`WEBMEET_TAG_RELAY_SUBMIT_TOOL=research_task_submit`,
`WEBMEET_TAG_RELAY_LIST_TOOL=research_relay_list_backends`, and
`WEBMEET_TAG_RELAY_TAGS=open-interpreter`, with
`WEBMEET_TAG_RELAY_TIMEOUT_MS` controlling delegated call timeout. When the
static tag allowlist is present, WebMeet must use it directly instead of
performing a catalog preflight. Unknown mentions such as `@teammate` must
remain ordinary chat and must not produce research relay errors.

The research result must be appended to the same meeting chat as an
agent-kind message. This is a chat reply and task result. It must not create,
fake, or imply a LiveKit AI participant; LiveKit AI participants remain governed
by DS10.

The `research:` author id prefix is reserved for relay-generated chat messages.
Authenticated MCP chat submissions must derive the normal user author identity
from invocation auth when it is available, instead of trusting caller-supplied
`authorId` and `authorName` fields. Public guest HTTP chat keeps its separate
guest-token participant validation path.

If the research relay is unavailable or a backend is not configured, WebMeet
should append a natural-language error from `Research Relay` rather than
discarding the user message.

Public guest HTTP chat does not currently dispatch research tags because it
does not carry the router invocation token needed for delegated MCP calls.

## Decisions & Questions

### Question #1: Why dispatch after persisting the user message?

Response:
The chat transcript should preserve what the user actually asked even if the
research relay fails or times out.

### Question #2: Why not use LiveKit AI dispatch for these tasks?

Response:
Tagged research tasks are request/response jobs executed through
`basic/bwrap-runner`. LiveKit AI dispatch represents real realtime meeting
participants and has a separate lifecycle.

### Question #3: Why reserve `research:` author ids?

Response:
Relay result messages are rendered in the same chat stream as user messages.
Reserving the prefix prevents authenticated tool callers from spoofing research
agent output while preserving normal participant ids for public guest chat.

## Conclusion

WebMeet supports tagged research tasks by appending relay results to chat while
preserving LiveKit participant integrity and Ploinky secure-wire boundaries.
