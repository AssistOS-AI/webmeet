# scripta-content

## Description

Generate SCRIPTA document content or one alternative formulation from the supplied structured context. This skill generates content only and never reads files, calls tools, or persists state.

## Input Format

The prompt is a JSON object. `task` is either `create-scripta-document` or paragraph reformulation.

## Output Format

For Vision return JSON with `visionParagraphs` containing at least three distinct aspect paragraphs. For Plan return JSON with `chapters`, each containing a title and at least one paragraph. For reformulation return `{ "text": "..." }`. Do not add commentary.
