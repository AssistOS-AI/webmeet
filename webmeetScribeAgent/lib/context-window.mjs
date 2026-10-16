function serializedSize(value) {
    return Buffer.byteLength(JSON.stringify(value || []), 'utf8');
}

export function selectMeetingAnalysisTargetCount(state, {
    maxRawBytes = 180_000,
    requestedTargetCount = null,
} = {}) {
    const segments = Array.isArray(state?.segments) ? state.segments : [];
    const analyzed = Math.min(segments.length, Math.max(0, Number(state?.analyzedSegmentCount || 0)));
    const requested = Math.min(
        segments.length,
        Math.max(analyzed, Number(requestedTargetCount ?? segments.length)),
    );
    if (requested <= analyzed) return requested;
    let target = analyzed;
    while (target < requested) {
        const candidate = target + 1;
        if (candidate > analyzed + 1 && serializedSize(segments.slice(0, candidate)) > maxRawBytes) break;
        target = candidate;
    }
    return target;
}

export function selectMeetingMemoryCompaction(state, {
    maxRawBytes = 180_000,
    maxBatchBytes = 60_000,
    throughSegmentCount = Number(state?.analyzedSegmentCount || 0),
} = {}) {
    const segments = Array.isArray(state?.segments) ? state.segments : [];
    const start = Math.max(0, Number(state?.compactedSegmentCount || 0));
    const endLimit = Math.min(
        segments.length,
        Math.max(0, Number(throughSegmentCount || 0)),
    );
    if (start >= endLimit) return null;
    const pending = segments.slice(start, endLimit);
    if (serializedSize(pending) <= maxRawBytes) return null;

    const targetRemainingBytes = Math.max(1, Math.floor(maxRawBytes * 0.6));
    let end = start;
    let batchBytes = 0;
    while (end < endLimit) {
        const nextBytes = serializedSize(segments[end]);
        const remainingAfter = serializedSize(segments.slice(end + 1, endLimit));
        if (end > start && batchBytes + nextBytes > maxBatchBytes) break;
        batchBytes += nextBytes;
        end += 1;
        if (remainingAfter <= targetRemainingBytes) break;
    }
    if (end <= start) end = start + 1;
    return { start, end, segments: structuredClone(segments.slice(start, end)) };
}

export function createMeetingAnalysisSnapshot(state, { targetSegmentCount = null } = {}) {
    const segments = Array.isArray(state?.segments) ? state.segments : [];
    const targetCount = Math.min(
        segments.length,
        Math.max(0, Number(targetSegmentCount ?? segments.length)),
    );
    const analyzedSegmentCount = Math.min(
        targetCount, Math.max(0, Number(state?.analyzedSegmentCount || 0)),
    );
    const compactedSegmentCount = Math.min(
        targetCount, Math.max(0, Number(state?.compactedSegmentCount || 0)),
    );
    return {
        targetSegmentCount: targetCount,
        compactedSegmentCount,
        discussionMemory: String(state?.discussionMemory || ''),
        journal: structuredClone(segments.slice(compactedSegmentCount, targetCount)),
        newSegmentIds: segments.slice(analyzedSegmentCount, targetCount)
            .map((segment) => String(segment?.segmentId || '').trim())
            .filter(Boolean),
        currentMarkdown: String(state?.currentMarkdown || ''),
        documentSnapshot: state?.documentSnapshot
            ? structuredClone(state.documentSnapshot)
            : null,
    };
}
