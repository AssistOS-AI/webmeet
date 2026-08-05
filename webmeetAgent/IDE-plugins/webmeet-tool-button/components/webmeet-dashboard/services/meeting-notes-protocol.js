export const MEETING_NOTES_TRANSCRIPT_TOPIC = 'webmeet.scribe.transcript.v1';
export const MEETING_NOTES_AGENT_TYPE = 'meeting_secretary';
export const MEETING_NOTES_AGENT_MODE = 'cumulative_notes';
export const MEETING_NOTES_MAX_SEGMENT_LENGTH = 12_000;

function cleanText(value, maxLength = MEETING_NOTES_MAX_SEGMENT_LENGTH) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanIso(value) {
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

export function buildMeetingNotesTranscriptSegment(input = {}) {
    const segmentId = cleanText(input.segmentId, 200);
    const text = cleanText(input.text);
    const sequence = Number(input.sequence);
    if (!segmentId) throw new Error('Meeting-notes transcript segment id is required.');
    if (!text) throw new Error('Meeting-notes transcript text is required.');
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new Error('Meeting-notes transcript sequence must be a positive integer.');
    }
    return {
        protocol: MEETING_NOTES_TRANSCRIPT_TOPIC,
        segmentId,
        sequence,
        text,
        language: cleanText(input.language, 80),
        startedAt: cleanIso(input.startedAt),
        endedAt: cleanIso(input.endedAt) || new Date().toISOString(),
        final: true,
    };
}

export function parseMeetingNotesTranscriptSegment(value) {
    const raw = typeof value === 'string' ? JSON.parse(value) : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid meeting-notes transcript payload.');
    }
    if (raw.protocol !== MEETING_NOTES_TRANSCRIPT_TOPIC || raw.final !== true) {
        throw new Error('Unsupported meeting-notes transcript protocol.');
    }
    return buildMeetingNotesTranscriptSegment(raw);
}

export function isMeetingNotesSecretaryParticipant(participant = null) {
    const attributes = participant?.attributes && typeof participant.attributes === 'object'
        ? participant.attributes
        : {};
    return String(attributes.webmeetAgentType || attributes.agentType || '').trim() === MEETING_NOTES_AGENT_TYPE
        || String(attributes.webmeetMeetingSecretary || '').trim().toLowerCase() === 'true';
}
