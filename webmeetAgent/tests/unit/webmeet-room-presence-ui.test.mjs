import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MeetingListController } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/controllers/meeting-list-controller.js';

const root = path.resolve(import.meta.dirname, '../..');
const modalDir = path.join(root, 'IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal');

async function readModalFile(relativePath) {
    return readFile(path.join(modalDir, relativePath), 'utf8');
}

test('LiveKit active speaker events are forwarded into participant roster state', async () => {
    const livekitController = await readModalFile('controllers/livekit-room-controller.js');
    const roomSessionMethods = await readModalFile('controllers/room-session-methods.js');
    const participantViewMethods = await readModalFile('controllers/participant-view-methods.js');

    assert.match(livekitController, /RoomEvent\.ActiveSpeakersChanged/);
    assert.match(livekitController, /onActiveSpeakersChanged/);
    assert.match(roomSessionMethods, /setActiveSpeakers\(participants,\s*Track\)/);
    assert.match(participantViewMethods, /activeSpeakerIds/);
    assert.match(participantViewMethods, /isSpeaking:\s*Boolean\(entry\.isSpeaking\)/);
});

test('room notification sounds are local, generated, and setting controlled', async () => {
    const modal = await readModalFile('webmeet-dashboard-modal.js');
    const mediaSettings = await readModalFile('controllers/media-settings-methods.js');
    const soundService = await readModalFile('services/room-notification-sounds.js');

    assert.match(modal, /createRoomNotificationSoundService/);
    assert.match(modal, /playParticipantJoinSound/);
    assert.match(modal, /playParticipantLeaveSound/);
    assert.match(modal, /isLocalParticipantIdentity/);
    assert.match(modal, /webmeetRoomNotificationSounds/);
    assert.match(mediaSettings, /roomNotificationSounds:\s*true/);
    assert.match(soundService, /createOscillator/);
    assert.doesNotMatch(soundService, /fetch\(/);
});

test('participant room list renders stable active speaker indicator markup', async () => {
    const meetingListController = await readModalFile('controllers/meeting-list-controller.js');
    const stylesheet = await readModalFile('webmeet-dashboard-modal.css');

    assert.match(meetingListController, /is-speaking/);
    assert.match(meetingListController, /webmeet-room-participant-speaking/);
    assert.match(meetingListController, /aria-hidden="true"/);
    assert.match(stylesheet, /\.webmeet-room-participant-speaking/);
    assert.match(stylesheet, /@keyframes webmeet-speaking-pulse/);
});

test('meeting list marks speaking participants without removing idle placeholders', () => {
    const controller = new MeetingListController();
    const element = { innerHTML: '' };
    controller.setElement(element);

    controller.render([{
        id: 'meeting-1',
        title: 'Room',
        roomType: 'team'
    }], 'meeting-1', {
        'meeting-1': [{
            id: 'participant-a',
            name: 'Alice',
            micOn: true,
            isSpeaking: true
        }, {
            id: 'participant-b',
            name: 'Bob',
            micOn: false,
            isSpeaking: false
        }]
    });

    assert.match(element.innerHTML, /webmeet-room-participant is-speaking/);
    assert.match(element.innerHTML, /webmeet-room-participant-speaking/);
    assert.match(element.innerHTML, /webmeet-room-participant-speaking is-idle/);
});
