# webmeetScribeAgent Agent Guide

## Scope

`webmeetScribeAgent` owns the text-only LiveKit Meeting Secretary worker, encrypted temporary transcript journals, cumulative meeting-note analysis, and internal calls to `webmeetAgent`.

## Rules

- Never subscribe to, persist, or log LiveKit audio.
- Accept only final, participant-addressed transcript packets from admitted LiveKit participants.
- Keep journals encrypted under `/data/sessions`; purge them after the documented recovery window.
- Notes analysis is holistic: the complete cumulative journal and current document are inputs to every revision.
- `webmeetAgent` remains authoritative for rooms, participants, Blackboard, and SCRIPTA persistence.
- Update `AGENTS.md` and `CLAUDE.md` together.
