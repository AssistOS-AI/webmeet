# blackboard-event

## Description

Interpret one natural-language WebMeet blackboard instruction into one canonical event. The instruction may be written in any language. This skill only interprets and validates intent; it never persists state or calls tools.

## Input Format

The prompt is the complete participant instruction. Runtime context contains `board`, `selectedWidget`, and `scripta`. Return exactly one JSON object with `target`, `action`, and `payload`. If the instruction is ambiguous, return `{ "clarificationRequired": true, "message": "..." }` and do not invent identifiers.

## Output Format

A canonical blackboard event JSON object or a clarification object.
