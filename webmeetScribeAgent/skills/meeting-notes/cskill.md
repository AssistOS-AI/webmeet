# meeting-notes

## Description

Reconcile a complete meeting-notes document from the entire cumulative, speaker-attributed meeting journal and the current document. No journal slice may directly mutate the document in isolation. Every distinct substantive topic and contribution from the supplied discussion must remain concretely represented; generic statements that omit the actual substance are invalid.

## Input Format

JSON containing `journal`, `currentMarkdown`, `participants`, and the editable configured `structurePrompt` that describes only the title and chapter organization.

## Output Format

Return one complete Markdown document and nothing else. Follow the configured document structure. The default structure requests a meeting title followed by chapters `Summary`, `Ideas and proposals`, `Decisions`, `Questions`, `Risks`, `Actions`, and `Unresolved points`. Output-format, reconciliation, attribution, and SCRIPTA-safety rules are internal skill instructions and are not part of the editable structure setting.
