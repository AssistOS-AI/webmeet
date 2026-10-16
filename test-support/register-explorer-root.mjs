import { register } from 'node:module';

// Preloaded with `node --import` so browser-served plugin sources that import
// absolute `/explorer/...` URLs resolve to the Explorer checkout under Node.
// Importing explorer-root.mjs throws when the checkout is missing.
import { EXPLORER_ROOT, explorerUrl } from './explorer-root.mjs';

register('./explorer-root-hooks.mjs', import.meta.url, { data: { explorerRoot: EXPLORER_ROOT } });

// webmeet_tool.mjs loads the invocation-auth helper at import time and falls
// back to a path beside Explorer's shared/ directory that does not exist next
// to this repository. Point it at the Explorer checkout before any test imports it.
process.env.PLOINKY_INVOCATION_AUTH_MODULE ||= explorerUrl('shared', 'invocation-auth.mjs');
