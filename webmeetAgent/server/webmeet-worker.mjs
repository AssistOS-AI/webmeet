import {
    buildMeetingAiContext,
    createStoreContext,
    finalizeMeetingWithScribe,
    persistAssistantMessage,
    persistObserverSummary
} from '../lib/webmeetStore.mjs';
import { generateAssistantReply, generateObserverSummary, generateScribeOutput } from '../lib/webmeetLLM.mjs';
import { claimNextJob, completeJob, createQueueContext, failJob } from '../lib/webmeetQueue.mjs';

const POLL_MS = Number.parseInt(process.env.WEBMEET_WORKER_POLL_MS || '400', 10);
const WORKER_TYPES = String(process.env.WEBMEET_WORKER_TYPES || 'observer_refresh,assistant_reply,scribe_finalize')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

async function processJob(context, job) {
    const meetingId = String(job.payload?.meetingId || '').trim();
    if (!meetingId) {
        throw new Error('Worker job missing meetingId.');
    }
    const snapshot = buildMeetingAiContext(context, meetingId);
    if (job.type === 'observer_refresh') {
        const summary = await generateObserverSummary({
            meetingTitle: snapshot.meeting.title,
            previousSummary: snapshot.observerSummary,
            chatText: snapshot.chatText,
            transcriptText: snapshot.transcriptText
        });
        return { observerState: persistObserverSummary(context, meetingId, summary) };
    }
    if (job.type === 'assistant_reply') {
        const message = await generateAssistantReply({
            agentName: context.agentName,
            meetingTitle: snapshot.meeting.title,
            observerSummary: snapshot.observerSummary,
            transcriptText: snapshot.transcriptText,
            tasks: snapshot.tasks.map((entry) => entry.title),
            decisions: snapshot.decisions.map((entry) => entry.title),
            userMessage: String(job.payload?.userMessage || '').trim()
        });
        return {
            assistantMessage: persistAssistantMessage(context, meetingId, {
                agentId: String(job.payload?.agentId || '').trim(),
                message
            })
        };
    }
    if (job.type === 'scribe_finalize') {
        const output = await generateScribeOutput({
            meetingTitle: snapshot.meeting.title,
            observerSummary: snapshot.observerSummary,
            chatText: snapshot.chatText,
            transcriptText: snapshot.transcriptText
        });
        return finalizeMeetingWithScribe(context, meetingId, {
            summary: output.summary,
            tasks: Array.isArray(output.tasks) ? output.tasks : [],
            decisions: Array.isArray(output.decisions) ? output.decisions : []
        });
    }
    throw new Error(`Unsupported worker job type ${job.type}.`);
}

async function loop() {
    const context = createStoreContext();
    createQueueContext();
    while (true) {
        const claimed = claimNextJob(context.workspaceRoot, WORKER_TYPES);
        if (!claimed) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            continue;
        }
        try {
            const result = await processJob(context, claimed.job);
            completeJob(claimed.filePath, result);
        } catch (error) {
            failJob(claimed.filePath, error);
        }
    }
}

loop().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
});
