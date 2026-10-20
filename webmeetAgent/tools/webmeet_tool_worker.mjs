#!/usr/bin/env node
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { handleWebMeetToolCall } from './webmeet_tool.mjs';
import { UNCONFIRMED_ROOM_LOCK_RELEASE_KEY } from '../lib/store/roomLocks.mjs';

export const RECYCLE_REQUEST_ENV = 'WEBMEET_TOOL_WORKER_RECYCLE';

// A room lock whose release could not be confirmed may stay on disk owned by
// this live pid. Changing process.env during a call is the supported way to
// make the Ploinky worker restore the environment and recycle (exit) after
// delivering the result, so the leaked lock is recovered through the existing
// stale-TTL path instead of waiting for this worker to retire.
export function requestRecycleIfLockUnconfirmed(env = process.env) {
    if (!globalThis[UNCONFIRMED_ROOM_LOCK_RELEASE_KEY]) return false;
    globalThis[UNCONFIRMED_ROOM_LOCK_RELEASE_KEY] = false;
    env[RECYCLE_REQUEST_ENV] = '1';
    return true;
}

// Adapts a Ploinky tool-worker call frame to the per-call WebMeet handler.
// As in spawn mode, the tool's configured TOOL_NAME wins over the frame name.
// Errors produce the CLI's bytes: the message plus a newline on stderr, exit 1.
export function createWebMeetWorkerHandler({ handleCall = handleWebMeetToolCall } = {}) {
    return async ({ toolName, toolEnv, envelope, stdout, stderr }) => {
        const name = String(toolEnv?.TOOL_NAME || toolName || '').trim();
        try {
            await handleCall({ toolName: name, envelope, stdout });
            return { exitCode: 0 };
        } catch (error) {
            stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
            return { exitCode: 1 };
        } finally {
            requestRecycleIfLockUnconfirmed();
        }
    };
}

export async function serveWebMeetToolWorker({
    workerModulePath = process.env.PLOINKY_TOOL_WORKER_MODULE,
    handler = createWebMeetWorkerHandler()
} = {}) {
    if (typeof workerModulePath !== 'string' || !path.isAbsolute(workerModulePath)) {
        throw new Error('WebMeet worker requires an absolute PLOINKY_TOOL_WORKER_MODULE path.');
    }
    const { serveToolWorker } = await import(pathToFileURL(workerModulePath).href);
    await serveToolWorker(handler);
}

function isDirectExecution() {
    try {
        return Boolean(process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)));
    } catch {
        return false;
    }
}

if (isDirectExecution()) {
    serveWebMeetToolWorker().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
