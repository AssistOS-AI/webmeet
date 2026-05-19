import {
    logMediaDiagnostic,
    summarizePublication
} from '../services/media-diagnostics.js';
import { getMediaQualityProfile } from './media-quality-profiles.js';

export class WebmeetMediaController {
    constructor(options = {}) {
        this.getRoom = typeof options.getRoom === 'function' ? options.getRoom : (() => null);
        this.getTrack = typeof options.getTrack === 'function' ? options.getTrack : (() => window.LivekitClient?.Track || null);
        this.ensureBackgroundEffectsModule = typeof options.ensureBackgroundEffectsModule === 'function'
            ? options.ensureBackgroundEffectsModule
            : null;
        this.getBackgroundEffectsAssetPaths = typeof options.getBackgroundEffectsAssetPaths === 'function'
            ? options.getBackgroundEffectsAssetPaths
            : (() => ({}));
        this.onMediaStateChange = typeof options.onMediaStateChange === 'function' ? options.onMediaStateChange : (() => {});
        this.onMicStateChange = typeof options.onMicStateChange === 'function' ? options.onMicStateChange : (() => {});
        this.onError = typeof options.onError === 'function' ? options.onError : (() => {});
        this.onAfterToggle = typeof options.onAfterToggle === 'function' ? options.onAfterToggle : (() => {});
        this.settings = {
            audioInputDeviceId: '',
            videoInputDeviceId: '',
            audioOutputDeviceId: '',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            microphoneGain: 1,
            outputVolume: 1,
            cameraQuality: 'h720',
            screenShareQuality: 'h1080fps30',
            backgroundMode: 'none',
            backgroundBlurRadius: 12,
            backgroundImageDataUrl: '',
            backgroundImageName: ''
        };
        this.inFlight = false;
        this.customMicrophone = null;
        this.backgroundProcessor = null;
        this.backgroundProcessorTrack = null;
        this.backgroundSyncPromise = null;
    }

    reset() {
        this.inFlight = false;
        this.stopCustomMicrophoneCapture();
        void this.clearBackgroundEffect();
    }

    setSettings(next = {}) {
        this.settings = {
            ...this.settings,
            ...next
        };
    }

    getSettings() {
        return { ...this.settings };
    }

    normalizeBackgroundMode(value) {
        const mode = String(value || '').trim();
        return ['none', 'blur', 'image'].includes(mode) ? mode : 'none';
    }

    normalizeBackgroundBlurRadius(value) {
        const radius = Number(value);
        if (!Number.isFinite(radius)) return 12;
        return Math.min(24, Math.max(4, Math.round(radius)));
    }

    getLocalCameraTrack(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!localParticipant?.trackPublications?.values) return null;
        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication?.track) continue;
            const isCameraSource = Track?.Source?.Camera
                ? publication.source === Track.Source.Camera
                : String(publication.source || '').toLowerCase() === 'camera';
            const isFallbackCameraVideo = publication.kind === Track?.Kind?.Video && !publication.source;
            if (isCameraSource || isFallbackCameraVideo) {
                return publication.track;
            }
        }
        return null;
    }

    getBackgroundProcessorOptions() {
        const mode = this.normalizeBackgroundMode(this.settings.backgroundMode);
        if (mode === 'blur') {
            return {
                mode: 'background-blur',
                blurRadius: this.normalizeBackgroundBlurRadius(this.settings.backgroundBlurRadius),
                assetPaths: this.getBackgroundEffectsAssetPaths()
            };
        }
        if (mode === 'image') {
            const imagePath = String(this.settings.backgroundImageDataUrl || '').trim();
            if (!imagePath) {
                throw new Error('Choose a background image before enabling virtual background.');
            }
            return {
                mode: 'virtual-background',
                imagePath,
                assetPaths: this.getBackgroundEffectsAssetPaths()
            };
        }
        return {
            mode: 'disabled',
            assetPaths: this.getBackgroundEffectsAssetPaths()
        };
    }

    async ensureBackgroundEffectsSupport() {
        if (!this.ensureBackgroundEffectsModule) {
            throw new Error('Background effects are not available in this build.');
        }
        const module = await this.ensureBackgroundEffectsModule();
        if (typeof module?.BackgroundProcessor !== 'function') {
            throw new Error('Background effects failed to load.');
        }
        if (typeof module?.supportsBackgroundProcessors === 'function' && !module.supportsBackgroundProcessors()) {
            throw new Error('This browser does not support background blur or virtual background in WebMeet.');
        }
        return module;
    }

    async clearBackgroundEffect(track = this.backgroundProcessorTrack || this.getLocalCameraTrack()) {
        const targetTrack = track || null;
        if (targetTrack && typeof targetTrack.stopProcessor === 'function') {
            try {
                await targetTrack.stopProcessor();
            } catch (_) {
                // keep local state cleanup even if the SDK already released the processor
            }
        }
        this.backgroundProcessor = null;
        this.backgroundProcessorTrack = null;
    }

    async applyBackgroundEffectToCamera() {
        const backgroundMode = this.normalizeBackgroundMode(this.settings.backgroundMode);
        const cameraTrack = this.getLocalCameraTrack();
        if (!cameraTrack) {
            this.backgroundProcessor = null;
            this.backgroundProcessorTrack = null;
            return;
        }
        if (backgroundMode === 'none') {
            await this.clearBackgroundEffect(cameraTrack);
            return;
        }
        if (typeof cameraTrack.setProcessor !== 'function') {
            throw new Error('This browser cannot apply camera background effects.');
        }
        const module = await this.ensureBackgroundEffectsSupport();
        const options = this.getBackgroundProcessorOptions();
        if (this.backgroundProcessor && this.backgroundProcessorTrack === cameraTrack && typeof this.backgroundProcessor.switchTo === 'function') {
            await this.backgroundProcessor.switchTo(options);
            return;
        }
        if (this.backgroundProcessorTrack && this.backgroundProcessorTrack !== cameraTrack) {
            await this.clearBackgroundEffect(this.backgroundProcessorTrack);
        }
        const processor = module.BackgroundProcessor(options);
        await cameraTrack.setProcessor(processor);
        this.backgroundProcessor = processor;
        this.backgroundProcessorTrack = cameraTrack;
    }

    async syncBackgroundEffect() {
        const next = Promise.resolve(this.backgroundSyncPromise)
            .catch(() => {})
            .then(() => this.applyBackgroundEffectToCamera());
        this.backgroundSyncPromise = next.finally(() => {
            if (this.backgroundSyncPromise === next) {
                this.backgroundSyncPromise = null;
            }
        });
        return this.backgroundSyncPromise;
    }

    getMicrophoneEnableOptions() {
        const audioDeviceId = String(this.settings.audioInputDeviceId || '').trim();
        const deviceId = audioDeviceId
            ? ({ exact: audioDeviceId })
            : undefined;
        return {
            deviceId,
            channelCount: 1,
            sampleRate: 48000,
            echoCancellation: Boolean(this.settings.echoCancellation),
            noiseSuppression: Boolean(this.settings.noiseSuppression),
            autoGainControl: Boolean(this.settings.autoGainControl)
        };
    }

    getMicrophoneGain() {
        const value = Number(this.settings.microphoneGain);
        if (!Number.isFinite(value)) return 1;
        return Math.min(2, Math.max(0, value));
    }

    usesCustomMicrophoneGain() {
        return Math.abs(this.getMicrophoneGain() - 1) > 0.001;
    }

    getCameraQualityProfile() {
        return getMediaQualityProfile('camera', this.settings.cameraQuality);
    }

    getScreenShareQualityOptions() {
        const profile = getMediaQualityProfile('screen', this.settings.screenShareQuality);
        return {
            resolution: { ...profile.resolution }
        };
    }

    getCameraPublishOptions() {
        const profile = this.getCameraQualityProfile();
        return {
            videoEncoding: { ...profile.encoding }
        };
    }

    getScreenSharePublishOptions() {
        const profile = getMediaQualityProfile('screen', this.settings.screenShareQuality);
        return {
            simulcast: false,
            videoEncoding: { ...profile.encoding }
        };
    }

    getAudioContextConstructor() {
        return globalThis.AudioContext || globalThis.webkitAudioContext || null;
    }

    async stopCustomMicrophoneCapture() {
        const current = this.customMicrophone;
        this.customMicrophone = null;
        const room = this.getRoom();
        if (current?.track && room?.localParticipant?.unpublishTrack) {
            try {
                await room.localParticipant.unpublishTrack(current.track, true);
            } catch (_) {
                // continue with local cleanup
            }
        }
        for (const track of [
            current?.track,
            ...(current?.processedStream?.getTracks?.() || []),
            ...(current?.sourceStream?.getTracks?.() || [])
        ]) {
            try { track?.stop?.(); } catch (_) {}
        }
        try { current?.sourceNode?.disconnect?.(); } catch (_) {}
        try { current?.gainNode?.disconnect?.(); } catch (_) {}
        try { await current?.audioContext?.close?.(); } catch (_) {}
    }

    async enableDefaultMicrophone(room) {
        await this.stopCustomMicrophoneCapture();
        const options = this.getMicrophoneEnableOptions();
        try {
            await room.localParticipant.setMicrophoneEnabled(true, options);
        } catch (_) {
            await room.localParticipant.setMicrophoneEnabled(true);
        }
    }

    async enableCustomGainMicrophone(room) {
        if (!navigator?.mediaDevices?.getUserMedia) {
            throw new Error('Microphone capture is not supported in this browser.');
        }
        const AudioContextRef = this.getAudioContextConstructor();
        if (!AudioContextRef) {
            throw new Error('Audio processing is not supported in this browser.');
        }

        await room.localParticipant.setMicrophoneEnabled(false);
        await this.stopCustomMicrophoneCapture();

        let sourceStream = null;
        let audioContext = null;
        let sourceNode = null;
        let gainNode = null;
        let destination = null;
        let processedTrack = null;
        try {
            sourceStream = await navigator.mediaDevices.getUserMedia({
                audio: this.getMicrophoneEnableOptions(),
                video: false
            });
            audioContext = new AudioContextRef({ sampleRate: 48000 });
            sourceNode = audioContext.createMediaStreamSource(sourceStream);
            gainNode = audioContext.createGain();
            gainNode.gain.value = this.getMicrophoneGain();
            destination = audioContext.createMediaStreamDestination();
            sourceNode.connect(gainNode);
            gainNode.connect(destination);

            [processedTrack] = destination.stream.getAudioTracks();
            if (!processedTrack) {
                throw new Error('Processed microphone track could not be created.');
            }
            processedTrack.contentHint = 'speech';

            const Track = this.getTrack();
            const publishOptions = Track?.Source?.Microphone
                ? { source: Track.Source.Microphone, name: 'microphone' }
                : { name: 'microphone' };
            await room.localParticipant.publishTrack(processedTrack, publishOptions);
            this.customMicrophone = {
                sourceStream,
                processedStream: destination.stream,
                audioContext,
                sourceNode,
                gainNode,
                track: processedTrack
            };
        } catch (error) {
            for (const track of [
                processedTrack,
                ...(destination?.stream?.getTracks?.() || []),
                ...(sourceStream?.getTracks?.() || [])
            ]) {
                try { track?.stop?.(); } catch (_) {}
            }
            try { sourceNode?.disconnect?.(); } catch (_) {}
            try { gainNode?.disconnect?.(); } catch (_) {}
            try { await audioContext?.close?.(); } catch (_) {}
            throw error;
        }
    }

    async enableMicrophone(room) {
        if (!this.usesCustomMicrophoneGain()) {
            await this.enableDefaultMicrophone(room);
            return;
        }
        try {
            await this.enableCustomGainMicrophone(room);
        } catch (error) {
            await this.enableDefaultMicrophone(room);
            this.onError('Custom microphone volume is unavailable. Using standard microphone audio.');
        }
    }

    async disableMicrophone(room) {
        this.hardStopMicrophoneTracks();
        await this.stopCustomMicrophoneCapture();
        await room.localParticipant.setMicrophoneEnabled(false);
    }

    async restartMicrophone() {
        const room = this.getRoom();
        if (!room?.localParticipant || !this.isLocalSourceEnabled('microphone')) return;
        await this.runExclusiveToggle(async () => {
            await this.disableMicrophone(room);
            await this.enableMicrophone(room);
            await this.waitForLocalSourceState('microphone', true);
        });
    }

    getLocalMicrophoneTracks(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) return [];
        const tracks = [];
        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const isMic = publication.source === Track.Source.Microphone;
            const isCustomMic = publication.track && publication.track === this.customMicrophone?.track;
            if (!isMic && !isCustomMic) continue;
            if (publication.track) {
                tracks.push(publication.track);
            }
        }
        return tracks;
    }

    hasActiveMicrophoneCapture(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            const readyState = String(mediaStreamTrack?.readyState || '').toLowerCase();
            if (readyState === 'live') {
                return true;
            }
        }
        return false;
    }

    getActiveMicrophoneMediaStreamTrack(TrackRef = null) {
        const sourceTrack = this.customMicrophone?.sourceStream?.getAudioTracks?.()?.[0] || null;
        if (String(sourceTrack?.readyState || '').toLowerCase() === 'live') {
            return sourceTrack;
        }
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            const mediaStreamTrack = track?.mediaStreamTrack || null;
            if (String(mediaStreamTrack?.readyState || '').toLowerCase() === 'live') {
                return mediaStreamTrack;
            }
        }
        return null;
    }

    hardStopMicrophoneTracks(TrackRef = null) {
        const tracks = this.getLocalMicrophoneTracks(TrackRef);
        for (const track of tracks) {
            if (!track) continue;
            try {
                if (typeof track.stop === 'function') {
                    track.stop();
                    continue;
                }
            } catch (_) {
                // continue to fallback stop path
            }
            try {
                track.mediaStreamTrack?.stop?.();
            } catch (_) {
                // ignore best-effort stop errors
            }
        }
    }

    hardStopTrack(track) {
        if (!track) return;
        try {
            if (typeof track.stop === 'function') {
                track.stop();
                return;
            }
        } catch (_) {
            // continue to fallback stop path
        }
        try {
            track.mediaStreamTrack?.stop?.();
        } catch (_) {
            // ignore best-effort stop errors
        }
    }

    hardStopAllLocalPublishedTracks(room = this.getRoom()) {
        const publications = room?.localParticipant?.trackPublications?.values?.() || [];
        for (const publication of publications) {
            this.hardStopTrack(publication?.track || null);
        }
    }

    async stopAllLocalMedia(room = this.getRoom()) {
        this.hardStopMicrophoneTracks();
        await this.stopCustomMicrophoneCapture();
        await this.clearBackgroundEffect();
        const localParticipant = room?.localParticipant || null;
        if (localParticipant) {
            for (const action of [
                () => localParticipant.setMicrophoneEnabled?.(false),
                () => localParticipant.setCameraEnabled?.(false),
                () => localParticipant.setScreenShareEnabled?.(false)
            ]) {
                try {
                    const result = action();
                    if (result && typeof result.then === 'function') {
                        await result;
                    }
                } catch (_) {
                    // keep shutting down the remaining local sources
                }
            }
        }
        this.hardStopAllLocalPublishedTracks(room);
        const localId = String(room?.localParticipant?.identity || '').trim();
        this.onMediaStateChange({ microphone: false, camera: false, screen: false }, localId);
    }

    async waitForMicrophoneHardStopped(timeoutMs = 1500) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            if (!this.hasActiveMicrophoneCapture()) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return !this.hasActiveMicrophoneCapture();
    }

    getCameraEnableOptions() {
        const videoDeviceId = String(this.settings.videoInputDeviceId || '').trim();
        const deviceId = videoDeviceId
            ? ({ exact: videoDeviceId })
            : undefined;
        return {
            deviceId,
            resolution: { ...this.getCameraQualityProfile().resolution }
        };
    }

    isLocalSourceEnabled(type, TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        if (!Track || !localParticipant?.trackPublications?.values) {
            return false;
        }
        const sourceMap = {
            microphone: Track.Source?.Microphone,
            camera: Track.Source?.Camera,
            screen: Track.Source?.ScreenShare
        };
        const wantedSource = sourceMap[type];
        const wantedKind = type === 'microphone' ? Track.Kind.Audio : Track.Kind.Video;

        for (const publication of localParticipant.trackPublications.values()) {
            if (!publication) continue;
            const sameKind = publication.kind === wantedKind;
            const sameSource = wantedSource ? publication.source === wantedSource : false;
            const sameCustomMic = type === 'microphone'
                && sameKind
                && (publication.track === this.customMicrophone?.track || !publication.source);
            if ((sameSource || sameCustomMic || (type === 'camera' && sameKind && !publication.source))
                && !publication.isMuted) {
                return true;
            }
        }
        return false;
    }

    getLocalMediaStateFromRoom(TrackRef = null) {
        const Track = TrackRef || this.getTrack();
        const room = this.getRoom();
        const localParticipant = room?.localParticipant;
        const next = {
            microphone: false,
            camera: false,
            screen: false
        };
        if (!Track || !localParticipant?.trackPublications?.values) {
            return next;
        }
        next.microphone = this.isLocalSourceEnabled('microphone', Track) || this.hasActiveMicrophoneCapture(Track);
        next.camera = this.isLocalSourceEnabled('camera', Track);
        next.screen = this.isLocalSourceEnabled('screen', Track);
        return next;
    }

    async waitForLocalSourceState(type, enabled, timeoutMs = 1200) {
        const start = Date.now();
        while ((Date.now() - start) < timeoutMs) {
            const current = this.isLocalSourceEnabled(type);
            if (current === enabled) {
                return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 60));
        }
        return false;
    }

    syncLocalMediaStateFromRoom(TrackRef = null) {
        const next = this.getLocalMediaStateFromRoom(TrackRef);
        const room = this.getRoom();
        const localId = String(room?.localParticipant?.identity || '').trim();
        this.onMediaStateChange(next, localId);
        return next;
    }

    async runExclusiveToggle(action) {
        if (this.inFlight) {
            return;
        }
        this.inFlight = true;
        try {
            await action();
        } catch (error) {
            this.onError(error instanceof Error ? error.message : String(error));
        } finally {
            this.syncLocalMediaStateFromRoom();
            this.onAfterToggle();
            this.inFlight = false;
        }
    }

    async toggleMicrophone() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the microphone.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const enable = !this.isLocalSourceEnabled('microphone');
            if (enable) {
                await this.enableMicrophone(room);
            } else {
                await this.disableMicrophone(room);
                const hardStopped = await this.waitForMicrophoneHardStopped();
                if (!hardStopped) {
                    throw new Error('Microphone capture did not stop completely. Check browser permissions/device.');
                }
            }
            await this.waitForLocalSourceState('microphone', enable);
        });
    }

    async toggleCamera() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before enabling the camera.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableCamera = !this.isLocalSourceEnabled('camera');
            if (shouldEnableCamera) {
                const options = this.getCameraEnableOptions();
                const publishOptions = this.getCameraPublishOptions();
                try {
                    await localParticipant.setCameraEnabled(true, options, publishOptions);
                } catch (_) {
                    await localParticipant.setCameraEnabled(true);
                    this.onError('Selected camera quality could not be used. WebMeet is using browser default camera settings.');
                }
                await this.waitForLocalSourceState('camera', true);
                await this.syncBackgroundEffect();
            } else {
                await this.clearBackgroundEffect();
                await localParticipant.setCameraEnabled(false);
                await this.waitForLocalSourceState('camera', false);
            }
        });
    }

    async toggleScreenShare() {
        const room = this.getRoom();
        if (!room?.localParticipant) {
            this.onError('Join a meeting before starting screen share.');
            return;
        }
        await this.runExclusiveToggle(async () => {
            const localParticipant = room.localParticipant;
            const shouldEnableScreen = !this.isLocalSourceEnabled('screen');
            const captureOptions = this.getScreenShareQualityOptions();
            const publishOptions = this.getScreenSharePublishOptions();
            logMediaDiagnostic('screen-share-toggle-requested', {
                enable: shouldEnableScreen,
                captureOptions,
                publishOptions
            });
            if (shouldEnableScreen) {
                await localParticipant.setScreenShareEnabled(true, captureOptions, publishOptions);
            } else {
                await localParticipant.setScreenShareEnabled(false);
            }
            await this.waitForLocalSourceState('screen', shouldEnableScreen);
            logMediaDiagnostic('screen-share-toggle-completed', {
                enable: shouldEnableScreen,
                publications: Array.from(localParticipant.trackPublications?.values?.() || [])
                    .map((publication) => summarizePublication(publication))
            });
        });
    }
}
