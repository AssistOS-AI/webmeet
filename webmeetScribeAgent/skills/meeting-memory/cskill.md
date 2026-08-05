# meeting-memory

## Description

Reconcile a bounded cumulative discussion memory from the previous cumulative memory, the current holistic notes document, and the next chronological transcript range. This skill maintains context for long meetings; it never updates SCRIPTA notes directly.

## Input Format

JSON containing `previousMemory`, `segments`, `currentMarkdown`, and `participants`.

## Output Format

Return `{ "memory": "..." }`. The replacement memory must preserve relevant chronology, corrections, disagreements, explicit decisions, attribution, owners, deadlines, risks, unanswered questions, and superseded statements from all supplied prior memory and segments. Do not return commentary.
