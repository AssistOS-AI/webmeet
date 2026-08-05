import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const agentRoot = path.resolve(import.meta.dirname, '..');

for (const skillName of ['meeting-notes', 'meeting-memory']) {
    test(`${skillName} declares the cskill format sections required by Achilles`, async () => {
        const descriptor = await fs.readFile(
            path.join(agentRoot, 'skills', skillName, 'cskill.md'),
            'utf8'
        );

        assert.match(descriptor, /^## Input Format$/m);
        assert.match(descriptor, /^## Output Format$/m);
        assert.doesNotMatch(descriptor, /^## Input$/m);
        assert.doesNotMatch(descriptor, /^## Output$/m);
    });
}

test('the worker resumes pending journal analysis after session recovery', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );
    const startMethod = workerSource.match(/async start\(\) \{[\s\S]*?\n    \}/)?.[0] || '';

    assert.match(startMethod, /this\.state = await this\.journal\.load/);
    assert.match(startMethod, /this\.publishActivity/);
    assert.match(startMethod, /this\.schedulePendingAnalysis\(\);/);
    assert.match(startMethod, /omitted substantive topic window/);
    assert.match(startMethod, /delete this\.state\.analysisRetry/);
});

test('the worker retries only transient provider failures from one durable snapshot', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );
    const scheduleMethod = workerSource.match(/schedulePendingAnalysis\(\) \{[\s\S]*?\n    \}/)?.[0] || '';
    const analyzeMethod = workerSource.match(/async analyze\(\{ force = false, retry = false \} = \{\}\) \{[\s\S]*?\n    \}/)?.[0] || '';

    assert.match(scheduleMethod, /segments\.length <= Number\(this\.state\.lastAnalysisAttemptedSegmentCount/);
    assert.match(analyzeMethod, /lastAnalysisAttemptedSegmentCount = attemptTargetSegmentCount/);
    assert.match(analyzeMethod, /this\.state\.analysisRetry = \{/);
    assert.match(analyzeMethod, /isTransientAnalysisError\(error\)/);
    assert.match(analyzeMethod, /MAX_ANALYSIS_RETRIES/);
    assert.match(analyzeMethod, /retryState\.exhaustedAt/);
    assert.match(analyzeMethod, /this\.state\.analysisRetry\.exhaustedAt/);
    assert.match(analyzeMethod, /delete this\.state\.analysisRetry\.nextAttemptAt/);
    assert.match(analyzeMethod, /await this\.journal\.save\(this\.session\.sessionId, this\.state\)/);
});

test('the worker backs off transient LLM failures without changing the requested snapshot', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );

    assert.match(workerSource, /ANALYSIS_RETRY_DELAYS_MS = Object\.freeze\(\[10_000, 30_000, 90_000\]\)/);
    assert.match(workerSource, /scheduleAnalysisRetry\(/);
    assert.match(workerSource, /snapshot,\n\s*retryCount: 0/);
    assert.match(workerSource, /this\.requestAnalysis\(\{ retry: true \}\)/);
    assert.match(workerSource, /Number\.isFinite\(nextAttemptAt\)/);
    assert.match(workerSource, /waiting_for_new_speech/);
});

test('the worker bounds delegated MCP calls so a stalled document apply cannot block future revisions', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );

    assert.match(workerSource, /function withDeadline\(operation, timeoutMs, description\)/);
    assert.match(workerSource, /Delegated \$\{tool\} call/);
    assert.match(workerSource, /WEBMEET_SCRIBE_MCP_TIMEOUT_SECONDS/);
});

test('the worker persists generated Markdown and retries only its document apply', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );

    assert.match(workerSource, /this\.state\.pendingApply = \{/);
    assert.match(workerSource, /await this\.refreshSession\(\)/);
    assert.match(workerSource, /baseStateBase64: String\(snapshot\.documentSnapshot\?\.stateBase64 \|\| ''\)/);
    assert.match(workerSource, /pending\.baseStateBase64 \? \{ baseStateBase64: pending\.baseStateBase64 \}/);
    assert.match(workerSource, /await this\.journal\.save\(this\.session\.sessionId, this\.state\);/);
    assert.match(workerSource, /async applyPendingDocument\(\)/);
    assert.match(workerSource, /schedulePendingDocumentApply/);
    assert.match(workerSource, /will retry without LLM/);
    assert.match(workerSource, /if \(this\.state\.pendingApply\) \{/);
    assert.match(workerSource, /this\.schedulePendingDocumentApply\(0\)/);
});

test('the worker requests a full document snapshot only when opening a new analysis checkpoint', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );

    assert.match(workerSource, /refreshSession\(\{ includeDocumentSnapshot = false \} = \{\}\)/);
    assert.match(workerSource, /includeDocumentSnapshot: !snapshot/);
    assert.match(workerSource, /\.\.\.\(includeDocumentSnapshot \? \{ includeDocumentSnapshot: true \} : \{\}\)/);
    assert.doesNotMatch(workerSource, /async heartbeat\(\)[\s\S]*?refreshSession\(\{ includeDocumentSnapshot: true \}\)/);
});

test('a server reset cancels durable retries and disconnects the obsolete worker', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );
    const refreshMethod = workerSource.match(
        /async refreshSession\(\{ includeDocumentSnapshot = false \} = \{\}\) \{[\s\S]*?\n    \}/
    )?.[0] || '';
    const analyzeMethod = workerSource.match(
        /async analyze\(\{ force = false, retry = false \} = \{\}\) \{[\s\S]*?\n    \}/
    )?.[0] || '';

    assert.match(analyzeMethod, /const active = await this\.refreshSession/);
    assert.match(analyzeMethod, /if \(!active\) return null/);
    assert.match(refreshMethod, /this\.finalized = true/);
    assert.match(refreshMethod, /delete this\.state\.pendingApply/);
    assert.match(refreshMethod, /delete this\.state\.analysisRetry/);
    assert.match(refreshMethod, /clearTimeout\(this\.documentApplyTimer\)/);
    assert.match(refreshMethod, /await this\.journal\.remove\(this\.session\.sessionId\)/);
    assert.match(refreshMethod, /await this\.room\.disconnect\?\.\(\)/);
    assert.match(refreshMethod, /return false/);
});

test('finalization never forces an exhausted analysis checkpoint', async () => {
    const workerSource = await fs.readFile(
        path.join(agentRoot, 'server', 'livekit-scribe.mjs'),
        'utf8'
    );
    const finalizeMethod = workerSource.match(/async finalize\(\) \{[\s\S]*?\n    \}/)?.[0] || '';

    assert.match(finalizeMethod, /if \(this\.state\.analysisRetry\?\.exhaustedAt\) break/);
    assert.match(finalizeMethod, /catch \(error\)[\s\S]*analysisRetry\?\.exhaustedAt/);
    assert.doesNotMatch(finalizeMethod, /retry: Boolean\(this\.state\.analysisRetry && !this\.state\.analysisRetry\.exhaustedAt\)/);
});
