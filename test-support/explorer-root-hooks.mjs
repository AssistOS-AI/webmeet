import path from 'node:path';
import { pathToFileURL } from 'node:url';

let explorerRoot = '';

export function initialize(data) {
    explorerRoot = data.explorerRoot;
}

export function resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('/explorer/')) {
        const url = pathToFileURL(path.join(explorerRoot, specifier)).href;
        return nextResolve(url, context);
    }
    return nextResolve(specifier, context);
}
