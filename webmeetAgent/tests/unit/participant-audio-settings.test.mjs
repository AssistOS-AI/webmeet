import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mediaSettingsMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/media-settings-methods.js';

function createStorage() {
    const values = new Map();
    return {
        getItem(key) {
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) {
            values.set(key, String(value));
        },
        removeItem(key) {
            values.delete(key);
        }
    };
}

function createContext() {
    return {
        ...mediaSettingsMethods,
        state: {
            participantAudioSettings: {},
            session: {
                meeting: {
                    id: 'meeting-1'
                }
            },
            selectedMeetingId: ''
        },
        remoteAudioNormalizer: {
            refreshParticipant() {}
        },
        participantLayoutController: {
            refreshParticipantAudioState() {}
        }
    };
}

test('participant audio volume keeps an explicit one hundred percent override', () => {
    globalThis.window = {
        localStorage: createStorage()
    };
    const context = createContext();

    assert.deepEqual(context.getParticipantAudioSettings('participant-1'), {
        muted: false,
        volume: 0.8
    });
    assert.equal(context.hasParticipantAudioOverrideForParticipant('participant-1'), false);

    context.setParticipantAudioSettings('participant-1', {
        muted: false,
        volume: 1
    });

    assert.deepEqual(context.getParticipantAudioSettings('participant-1'), {
        muted: false,
        volume: 1
    });
    assert.equal(context.hasParticipantAudioOverrideForParticipant('participant-1'), true);

    context.state.participantAudioSettings = {};
    context.loadParticipantAudioSettings();
    assert.deepEqual(context.getParticipantAudioSettings('participant-1'), {
        muted: false,
        volume: 1
    });
    assert.equal(context.hasParticipantAudioOverrideForParticipant('participant-1'), true);

    context.setParticipantAudioSettings('participant-1', { reset: true });
    assert.equal(context.hasParticipantAudioOverrideForParticipant('participant-1'), false);
    assert.deepEqual(context.getParticipantAudioSettings('participant-1'), {
        muted: false,
        volume: 0.8
    });
});
