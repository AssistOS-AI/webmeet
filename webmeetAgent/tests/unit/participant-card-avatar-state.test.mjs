import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const layoutControllerPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/participant-layout-controller.js'
);
const participantCardPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-participant-card/webmeet-participant-card.js'
);
const roomSessionMethodsPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/room-session-methods.js'
);
const dashboardModalPath = path.join(
    repoRoot,
    'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/webmeet-dashbaoard.js'
);

test('participant layout controller persists avatar config and fallback attributes for late presenter init', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /applyParticipantProfileAvatar/);
    assert.match(source, /participant\?\.profileAvatar/);
    assert.match(source, /const avatarProjection = this\.applyParticipantProfileAvatar\(view, participant\)/);
    assert.doesNotMatch(source, /participant\?\.kind === 'local' && !avatarProjection/);
    assert.doesNotMatch(source, /profileAvatarController\.refresh\(view, participant/);
    assert.doesNotMatch(source, /const shouldUseProjectedAvatar = participant\?\.kind !== 'local'/);
    assert.match(source, /view\.avatarSource = 'projected'/);
    assert.match(source, /filter\(\(view\) => view\.avatarSource !== 'projected'\)/);
    assert.match(source, /applyParticipantAvatarState\(view\)/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /data-avatar-size/);
    assert.match(source, /JSON\.stringify\(payload\.avatarConfig\)/);
});

test('participant layout controller preserves projected avatars during media-only participant updates', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /avatarProjection\.projected/);
    assert.match(source, /avatarProjection\.changed/);
    assert.match(source, /view\.avatarSource === 'projected' && view\.avatarConfig/);
    assert.doesNotMatch(source, /profileAvatarController\.refresh\(view, participant/);
});

test('participant card updates avatar through a dedicated avatar state channel', async () => {
    const cardSource = await fs.readFile(participantCardPath, 'utf8');
    const layoutSource = await fs.readFile(layoutControllerPath, 'utf8');
    const applyStateBody = cardSource.slice(
        cardSource.indexOf('    applyState() {'),
        cardSource.indexOf('\n    applyAvatarState() {')
    );

    assert.match(cardSource, /setAvatarState\(patch = \{\}\)/);
    assert.match(cardSource, /applyAvatarState\(\)/);
    assert.doesNotMatch(applyStateBody, /renderAvatar\(initials\)/);
    assert.match(layoutSource, /presenter\.setAvatarState\(payload\)/);
});

test('dashboard primes the active local avatar before LiveKit renders participant cards', async () => {
    const actionSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/meeting-action-methods.js'
    ), 'utf8');
    const participantSource = await fs.readFile(path.join(
        repoRoot,
        'IDE-plugins/webmeet-tool-button/components/webmeet-dashbaoard/controllers/participant-view-methods.js'
    ), 'utf8');

    assert.match(actionSource, /await this\.webMeetRoom\.join\(payload\);/);
    assert.match(actionSource, /await this\.primeCurrentParticipantAvatarProjection\(\{ force: true \}\);/);
    assert.match(actionSource, /async primeCurrentParticipantAvatarProjection\(options = \{\}\)/);
    assert.match(actionSource, /this\.setRoomAvatar\(participantId, resolved\.avatar\)/);
    assert.match(actionSource, /profileAvatar: resolved\.avatar/);
    assert.match(actionSource, /if \(!profileAvatar && override\)/);
    assert.match(participantSource, /const profileAvatar = normalizeProfileAvatar\(participant\?\.profileAvatar\)\s+\|\| getRoomAvatarFor\(this, participantId\)/);
    assert.match(participantSource, /this\.webMeetRoom\.buildAvatarProjection\(localSourceAvatar, localIdentity\)/);
});

test('participant layout controller clears stale video elements when video state becomes empty', async () => {
    const source = await fs.readFile(layoutControllerPath, 'utf8');

    assert.match(source, /const videoElements = this\.getParticipantVideoElements\(view\)/);
    assert.match(source, /presenter\.setVideoElements\(videoElements\)/);
    assert.match(source, /presenter\.setVideoElement\(videoElements\[0\] \|\| null\)/);
    assert.match(source, /clearParticipantVideoSources\(participantId, sources = \[\]\)/);
    assert.match(source, /mediaElement\.remove\(\)/);
    assert.match(source, /this\.renderParticipantLayout\(\)/);
});

test('dashboard clears local camera and screen video elements when local media state turns off', async () => {
    const source = await fs.readFile(dashboardModalPath, 'utf8');

    assert.match(source, /onMediaStateChange: \(next, localParticipantId\) =>/);
    assert.match(source, /if \(!next\.camera\)/);
    assert.match(source, /clearParticipantVideoSources\(localParticipantId, \[/);
    assert.match(source, /Track\?\.Source\?\.Camera/);
    assert.match(source, /if \(!next\.screen\)/);
    assert.match(source, /Track\?\.Source\?\.ScreenShare/);
});

test('room session treats camera and screen-share sources as video when unpublish event lacks kind', async () => {
    const source = await fs.readFile(roomSessionMethodsPath, 'utf8');

    assert.match(source, /Track\.Source\?\.Camera/);
    assert.match(source, /Track\.Source\?\.ScreenShare/);
    assert.match(source, /rawKind === 'video' \|\| isVideoSource \? 'video'/);
    assert.match(source, /findTrackIdsForParticipant\(participantId, \{\s+kind: publicationKind,\s+source/s);
});

test('participant card restores avatar config and fallback letter from element attributes', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /ensureAxiFaceLoaded/);
    assert.match(source, /function parseAvatarConfig/);
    assert.match(source, /data-avatar-config/);
    assert.match(source, /data-avatar-fallback-letter/);
    assert.match(source, /avatarConfig:\s*parseAvatarConfig\(element\.getAttribute\('data-avatar-config'\)\)/);
    assert.match(source, /avatarFallbackLetter:\s*String\(element\.getAttribute\('data-avatar-fallback-letter'\) \|\| ''\)\.trim\(\)/);
    assert.match(source, /dataset\.avatarSize = size/);
});

test('participant card ignores stale video elements without active video tracks', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /function isActiveVideoElement\(mediaElement\)/);
    assert.match(source, /getVideoTracks/);
    assert.match(source, /readyState \|\| ''\)\.trim\(\) !== 'ended'/);
    assert.match(source, /const candidateElements = Array\.from\(mediaElements\)\.filter\(Boolean\)/);
    assert.match(source, /const nextElements = candidateElements\.filter\(isActiveVideoElement\)/);
    assert.match(source, /cleanupVideoElement\(element\)/);
    assert.match(source, /hasVideo: nextElements\.length > 0/);
});

test('participant card keeps fallback initials until axi-face is registered', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /!customElements\.get\('axi-face'\)/);
    assert.match(source, /this\.refs\.avatar\.textContent = fallback/);
    assert.match(source, /ensureAxiFaceLoaded\(\)/);
    assert.match(source, /avatarLoadFailedKey/);
    assert.match(source, /this\.avatarLoadFailedKey === loadKey/);
    assert.match(source, /this\.avatarRenderKey = ''/);
    assert.match(source, /this\.applyState\(\)/);
});

test('participant card verifies avatar DOM before skipping rerender', async () => {
    const source = await fs.readFile(participantCardPath, 'utf8');

    assert.match(source, /function isAvatarRenderCurrent\(avatarElement, key, options = \{\}\)/);
    assert.match(source, /avatarElement\.dataset\.avatarRenderKey !== key/);
    assert.match(source, /querySelector\('axi-face'\)/);
    assert.match(source, /requiresAxiFace: true/);
    assert.match(source, /this\.refs\.avatar\.dataset\.avatarRenderKey = key/);
    assert.doesNotMatch(source, /if \(this\.avatarRenderKey === key\) return;/);
});
