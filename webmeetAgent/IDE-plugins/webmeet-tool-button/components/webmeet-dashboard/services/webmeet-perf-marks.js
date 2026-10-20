const PERF_FLAG = /[?&]webmeetPerf=1(?:&|$)/;

// Records a `webmeet:<name>` performance mark only when the page URL carries
// ?webmeetPerf=1, for latency measurements. It never changes behaviour.
export function markWebMeetPerf(name) {
    try {
        if (!PERF_FLAG.test(String(globalThis.location?.search || ''))) return;
        globalThis.performance?.mark?.(`webmeet:${name}`);
    } catch (_) {
        // Measurement is best-effort.
    }
}
