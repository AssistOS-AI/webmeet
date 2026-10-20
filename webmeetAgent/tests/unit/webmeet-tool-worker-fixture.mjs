// Test-only WebMeet tool worker for webmeet-tool-worker.test.mjs. It runs the
// real worker adapter and handler, and adds what a unit host lacks:
//   - LiveKit participants come from WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE (JSON
//     array, default empty) and join material from the edge-join fixture;
//   - the worker whose pid is in WEBMEET_WORKER_FIXTURE_FAULT_FILE fails its
//     first room-lock file removal with EIO (a release that cannot be confirmed);
//   - fixture_pid reports the worker pid, fixture_hold sleeps input.ms first and
//     fixture_hold_lock sleeps input.ms while holding the room lock of input.roomId.
import fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const realRm = fsp.rm.bind(fsp);
let faultInjected = false;
fsp.rm = async (file, options) => {
    const faultFile = process.env.WEBMEET_WORKER_FIXTURE_FAULT_FILE || '';
    if (faultFile && !faultInjected && String(file).includes(`${path.sep}locks${path.sep}rooms${path.sep}`)) {
        let target = '';
        try {
            target = readFileSync(faultFile, 'utf8').trim();
        } catch {}
        if (target === String(process.pid)) {
            faultInjected = true;
            throw Object.assign(new Error('EIO simulated'), { code: 'EIO' });
        }
    }
    return realRm(file, options);
};

const { handleWebMeetToolCall } = await import('../../tools/webmeet_tool.mjs');
const { createWebMeetWorkerHandler, serveWebMeetToolWorker } = await import('../../tools/webmeet_tool_worker.mjs');
const { createStoreContext } = await import('../../lib/webmeetStore.mjs');
const { withQueuedRoomLock } = await import('../../lib/store/roomLocks.mjs');
const { installEdgeJoinFixture } = await import('./edge-join-fixture.mjs');

function liveKitParticipants() {
    const file = process.env.WEBMEET_WORKER_FIXTURE_LIVEKIT_FILE || '';
    if (!file) return [];
    try {
        return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
        return [];
    }
}

async function createFixtureContext() {
    const context = installEdgeJoinFixture(await createStoreContext());
    context.listLiveKitParticipants = async () => liveKitParticipants();
    return context;
}

const real = createWebMeetWorkerHandler({
    handleCall: (call) => handleWebMeetToolCall({ ...call, createContext: createFixtureContext })
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Number(ms) || 0));

await serveWebMeetToolWorker({
    handler: async (call) => {
        const name = String(call.toolEnv?.TOOL_NAME || call.toolName || '').trim();
        const input = call.envelope?.input || {};
        if (name === 'fixture_pid' || name === 'fixture_hold') {
            if (name === 'fixture_hold') await sleep(input.ms);
            call.stdout.write(String(process.pid));
            return { exitCode: 0 };
        }
        if (name === 'fixture_hold_lock') {
            const context = await createStoreContext();
            await withQueuedRoomLock(context, input.roomId, () => sleep(input.ms));
            call.stdout.write(String(process.pid));
            return { exitCode: 0 };
        }
        return real(call);
    }
});
