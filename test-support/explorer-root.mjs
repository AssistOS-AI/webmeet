import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Resolves the AssistOSExplorer checkout that WebMeet tests import from.
// EXPLORER_ROOT overrides the default sibling checkout. A missing checkout
// throws: these tests exercise real Explorer code and must never skip.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const EXPLORER_ROOT = path.resolve(
    process.env.EXPLORER_ROOT || path.join(REPO_ROOT, '..', 'AssistOSExplorer'),
);

if (!fs.existsSync(path.join(EXPLORER_ROOT, 'explorer'))) {
    throw new Error(
        `AssistOSExplorer checkout not found at ${EXPLORER_ROOT}. `
        + 'Set EXPLORER_ROOT to a checkout that contains explorer/ and shared/.',
    );
}

export function explorerPath(...segments) {
    return path.join(EXPLORER_ROOT, ...segments);
}

export function explorerUrl(...segments) {
    return pathToFileURL(explorerPath(...segments)).href;
}
