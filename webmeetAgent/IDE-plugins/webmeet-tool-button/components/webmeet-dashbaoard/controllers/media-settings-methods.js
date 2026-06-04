import {
    DEFAULT_OUTPUT_VOLUME,
    DEFAULT_VOICE_PROCESSING_MODE,
    normalizeHumFilter as normalizeSharedHumFilter,
    normalizeMicrophoneGain as normalizeSharedMicrophoneGain,
    normalizeVoiceProcessingMode as normalizeSharedVoiceProcessingMode
} from '../services/audio-processing/settings.js';

function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

const PARTICIPANT_AUDIO_SETTINGS_STORAGE_KEY = 'webmeet.participantAudioSettings';
const MEDIA_SETTINGS_STORAGE_KEY = 'webmeet.mediaSettings';

export const mediaSettingsMethods = {
    registerMediaDeviceChangeHandler() {
        if (this.handleMediaDeviceChange || !navigator?.mediaDevices?.addEventListener) {
            return;
        }
        this.handleMediaDeviceChange = () => {
            void this.refreshMediaDevices({ requestPermission: false, showToast: true });
        };
        navigator.mediaDevices.addEventListener('devicechange', this.handleMediaDeviceChange);
    },

    unregisterMediaDeviceChangeHandler() {
        if (!this.handleMediaDeviceChange || !navigator?.mediaDevices?.removeEventListener) {
            this.handleMediaDeviceChange = null;
            return;
        }
        navigator.mediaDevices.removeEventListener('devicechange', this.handleMediaDeviceChange);
        this.handleMediaDeviceChange = null;
    },

    registerMediaSettingsInputHandlers() {
        if (this.mediaSettingsPanel?.dataset?.boundInputHandlers === 'true') {
            return;
        }
        const syncDraftFromControls = () => {
            this.syncMediaSettingsDraftFromInputs();
        };
        const switchAutomaticVoiceProcessingToCustom = () => {
            if (this.voiceProcessingModeSelect?.value === 'auto') {
                this.voiceProcessingModeSelect.value = 'custom';
            }
        };
        const updateMicrophoneGainPreview = () => {
            switchAutomaticVoiceProcessingToCustom();
            const microphoneGain = this.normalizeMicrophoneGain(this.microphoneGainInput?.value);
            syncDraftFromControls();
            if (this.microphoneGainValue) {
                this.microphoneGainValue.textContent = this.formatPercent(microphoneGain);
            }
            if (this.microphoneGainWarning) {
                this.microphoneGainWarning.classList.toggle('webmeet-hidden', microphoneGain <= 1.25);
            }
        };
        const updateOutputVolumePreview = () => {
            const outputVolume = this.normalizeOutputVolume(this.outputVolumeInput?.value);
            syncDraftFromControls();
            if (this.outputVolumeValue) {
                this.outputVolumeValue.textContent = this.formatPercent(outputVolume);
            }
            this.applyOutputVolumePreviewToAllAudioElements(outputVolume);
        };
        const handleSelectOrCheckboxChange = () => {
            syncDraftFromControls();
            this.renderMediaSettingsPanel();
        };
        const handleManualVoiceProcessingControlChange = () => {
            switchAutomaticVoiceProcessingToCustom();
            handleSelectOrCheckboxChange();
        };
        const handleAvatarPresetChange = () => {
            this.syncWebMeetAvatarSettingsDraftFromInputs?.();
        };
        const updateBackgroundBlurPreview = () => {
            const blurRadius = this.normalizeBackgroundBlurRadius(this.backgroundBlurInput?.value);
            syncDraftFromControls();
            if (this.backgroundBlurValue) {
                this.backgroundBlurValue.textContent = `${blurRadius}px`;
            }
        };
        this.microphoneGainInput?.addEventListener?.('input', updateMicrophoneGainPreview);
        this.outputVolumeInput?.addEventListener?.('input', updateOutputVolumePreview);
        this.roomNotificationSoundsInput?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.roomNotificationSoundsInput?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.audioInputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.videoInputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.audioOutputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.cameraQualitySelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.screenShareQualitySelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.echoCancellationInput?.addEventListener?.('change', handleManualVoiceProcessingControlChange);
        this.echoCancellationInput?.addEventListener?.('input', handleManualVoiceProcessingControlChange);
        this.noiseSuppressionInput?.addEventListener?.('change', handleManualVoiceProcessingControlChange);
        this.noiseSuppressionInput?.addEventListener?.('input', handleManualVoiceProcessingControlChange);
        this.autoGainControlInput?.addEventListener?.('change', handleManualVoiceProcessingControlChange);
        this.autoGainControlInput?.addEventListener?.('input', handleManualVoiceProcessingControlChange);
        this.automaticParticipantVolumeInput?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.automaticParticipantVolumeInput?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.voiceProcessingModeSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.voiceProcessingModeSelect?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.humFilterSelect?.addEventListener?.('change', handleManualVoiceProcessingControlChange);
        this.humFilterSelect?.addEventListener?.('input', handleManualVoiceProcessingControlChange);
        this.backgroundEffectSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.backgroundEffectSelect?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.avatarPresetSelect?.addEventListener?.('change', handleAvatarPresetChange);
        this.avatarPresetSelect?.addEventListener?.('input', handleAvatarPresetChange);
        this.avatarSettingsForm?.addEventListener?.('avatar-settings-change', handleAvatarPresetChange);
        this.backgroundBlurInput?.addEventListener?.('input', updateBackgroundBlurPreview);
        this.backgroundImageInput?.addEventListener?.('change', async (event) => {
            await this.handleBackgroundImageSelection(event?.target?.files);
        });
        this.backgroundImageRemoveButton?.addEventListener?.('click', (event) => {
            event.preventDefault();
            this.removeDraftBackgroundImage();
        });
        if (this.mediaSettingsPanel?.dataset) {
            this.mediaSettingsPanel.dataset.boundInputHandlers = 'true';
        }
    },

    loadMediaSettings() {
        const fallback = {
            audioInputDeviceId: '',
            videoInputDeviceId: '',
            audioOutputDeviceId: '',
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: false,
            automaticParticipantVolume: true,
            microphoneGain: 1,
            voiceProcessingMode: DEFAULT_VOICE_PROCESSING_MODE,
            humFilter: 'off',
            outputVolume: DEFAULT_OUTPUT_VOLUME,
            roomNotificationSounds: true,
            cameraQuality: 'h720',
            screenShareQuality: 'h1080fps30',
            backgroundMode: 'none',
            backgroundBlurRadius: 12,
            backgroundImageDataUrl: '',
            backgroundImageName: ''
        };
        try {
            const raw = String(window?.localStorage?.getItem(MEDIA_SETTINGS_STORAGE_KEY) || '').trim();
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                ...fallback,
                ...parsed,
                microphoneGain: this.normalizeMicrophoneGain(parsed?.microphoneGain),
                voiceProcessingMode: this.normalizeVoiceProcessingMode(parsed?.voiceProcessingMode),
                humFilter: this.normalizeHumFilter(parsed?.humFilter),
                outputVolume: this.normalizeOutputVolume(parsed?.outputVolume),
                roomNotificationSounds: parsed?.roomNotificationSounds !== false,
                cameraQuality: this.normalizeCameraQuality(parsed?.cameraQuality),
                screenShareQuality: this.normalizeScreenShareQuality(parsed?.screenShareQuality),
                backgroundMode: this.normalizeBackgroundMode(parsed?.backgroundMode),
                backgroundBlurRadius: this.normalizeBackgroundBlurRadius(parsed?.backgroundBlurRadius),
                backgroundImageDataUrl: this.normalizeBackgroundImageDataUrl(parsed?.backgroundImageDataUrl),
                backgroundImageName: this.normalizeBackgroundImageName(parsed?.backgroundImageName)
            };
        } catch {
            return fallback;
        }
    },

    normalizeMediaSettings(settings = {}) {
        return {
            audioInputDeviceId: String(settings.audioInputDeviceId || '').trim(),
            videoInputDeviceId: String(settings.videoInputDeviceId || '').trim(),
            audioOutputDeviceId: String(settings.audioOutputDeviceId || '').trim(),
            echoCancellation: settings.echoCancellation !== false,
            noiseSuppression: settings.noiseSuppression !== false,
            autoGainControl: settings.autoGainControl === true,
            automaticParticipantVolume: settings.automaticParticipantVolume !== false,
            microphoneGain: this.normalizeMicrophoneGain(settings.microphoneGain),
            voiceProcessingMode: this.normalizeVoiceProcessingMode(settings.voiceProcessingMode),
            humFilter: this.normalizeHumFilter(settings.humFilter),
            outputVolume: this.normalizeOutputVolume(settings.outputVolume),
            roomNotificationSounds: settings.roomNotificationSounds !== false,
            cameraQuality: this.normalizeCameraQuality(settings.cameraQuality),
            screenShareQuality: this.normalizeScreenShareQuality(settings.screenShareQuality),
            backgroundMode: this.normalizeBackgroundMode(settings.backgroundMode),
            backgroundBlurRadius: this.normalizeBackgroundBlurRadius(settings.backgroundBlurRadius),
            backgroundImageDataUrl: this.normalizeBackgroundImageDataUrl(settings.backgroundImageDataUrl),
            backgroundImageName: this.normalizeBackgroundImageName(settings.backgroundImageName)
        };
    },

    cloneCurrentMediaSettings() {
        return this.normalizeMediaSettings(this.state.mediaSettings);
    },

    getCurrentMediaSettingsForPanel() {
        if (this.state.mediaSettingsPanelVisible && this.state.mediaSettingsDraft) {
            return this.normalizeMediaSettings(this.state.mediaSettingsDraft);
        }
        return this.cloneCurrentMediaSettings();
    },

    beginMediaSettingsDraft() {
        this.state.mediaSettingsDraft = this.cloneCurrentMediaSettings();
    },

    clearMediaSettingsDraft() {
        this.state.mediaSettingsDraft = null;
    },

    syncMediaSettingsDraftFromInputs() {
        if (!this.state.mediaSettingsPanelVisible) return;
        this.state.mediaSettingsDraft = this.collectMediaSettingsFromInputs(this.state.mediaSettingsDraft || this.state.mediaSettings);
    },

    normalizeMicrophoneGain(value) {
        return normalizeSharedMicrophoneGain(value);
    },

    normalizeVoiceProcessingMode(value) {
        return normalizeSharedVoiceProcessingMode(value);
    },

    normalizeHumFilter(value) {
        return normalizeSharedHumFilter(value);
    },

    normalizeOutputVolume(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return DEFAULT_OUTPUT_VOLUME;
        return Math.min(1, Math.max(0, numberValue));
    },

    normalizeBackgroundMode(value) {
        const mode = String(value || '').trim();
        return ['none', 'blur', 'image'].includes(mode) ? mode : 'none';
    },

    normalizeBackgroundBlurRadius(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return 12;
        return Math.min(24, Math.max(4, Math.round(numberValue)));
    },

    normalizeBackgroundImageDataUrl(value) {
        const raw = String(value || '').trim();
        return raw.startsWith('data:image/') ? raw : '';
    },

    normalizeBackgroundImageName(value) {
        return String(value || '').trim();
    },

    async readFileAsDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Background image could not be read.'));
            reader.readAsDataURL(file);
        });
    },

    async handleBackgroundImageSelection(fileList) {
        const file = fileList?.[0] || null;
        if (!file) return;
        try {
            const dataUrl = await this.readFileAsDataUrl(file);
            const nextSettings = this.collectMediaSettingsFromInputs(this.state.mediaSettingsDraft || this.state.mediaSettings);
            this.state.mediaSettingsDraft = this.normalizeMediaSettings({
                ...nextSettings,
                backgroundMode: 'image',
                backgroundImageDataUrl: dataUrl,
                backgroundImageName: file.name || 'Custom background'
            });
            this.renderMediaSettingsPanel();
        } catch (error) {
            this.setError(error instanceof Error ? error.message : 'Background image could not be loaded.');
        } finally {
            if (this.backgroundImageInput) {
                this.backgroundImageInput.value = '';
            }
        }
    },

    removeDraftBackgroundImage() {
        const nextSettings = this.collectMediaSettingsFromInputs(this.state.mediaSettingsDraft || this.state.mediaSettings);
        this.state.mediaSettingsDraft = this.normalizeMediaSettings({
            ...nextSettings,
            backgroundMode: nextSettings.backgroundMode === 'image' ? 'none' : nextSettings.backgroundMode,
            backgroundImageDataUrl: '',
            backgroundImageName: ''
        });
        if (this.backgroundImageInput) {
            this.backgroundImageInput.value = '';
        }
        this.renderMediaSettingsPanel();
    },

    getMediaSettingsValidationError(settings = this.state.mediaSettings) {
        const normalized = this.normalizeMediaSettings(settings);
        if (normalized.backgroundMode === 'image' && !normalized.backgroundImageDataUrl) {
            return 'Choose a background image before applying a virtual background.';
        }
        return '';
    },

    normalizeParticipantAudioVolume(value) {
        return this.normalizeOutputVolume(value);
    },

    normalizeParticipantAudioSettings(value) {
        const normalized = {
            muted: Boolean(value?.muted),
            volume: this.normalizeParticipantAudioVolume(value?.volume)
        };
        if (!normalized.muted && Math.abs(normalized.volume - 1) < 0.001) {
            return { muted: false, volume: 1 };
        }
        return normalized;
    },

    hasParticipantAudioOverrides(settings) {
        const normalized = this.normalizeParticipantAudioSettings(settings);
        return normalized.muted || Math.abs(normalized.volume - 1) >= 0.001;
    },

    getParticipantAudioSettingsMeetingId() {
        return String(this.state.session?.meeting?.id || this.state.selectedMeetingId || '').trim();
    },

    loadParticipantAudioSettings() {
        const meetingId = this.getParticipantAudioSettingsMeetingId();
        this.state.participantAudioSettings = {};
        if (!meetingId) return this.state.participantAudioSettings;
        try {
            const raw = String(window?.localStorage?.getItem(PARTICIPANT_AUDIO_SETTINGS_STORAGE_KEY) || '').trim();
            if (!raw) return this.state.participantAudioSettings;
            const parsed = JSON.parse(raw);
            const storedByMeeting = parsed && typeof parsed === 'object' ? parsed[meetingId] : null;
            if (!storedByMeeting || typeof storedByMeeting !== 'object') {
                return this.state.participantAudioSettings;
            }
            const next = {};
            for (const [participantId, value] of Object.entries(storedByMeeting)) {
                const id = String(participantId || '').trim();
                if (!id) continue;
                const normalized = this.normalizeParticipantAudioSettings(value);
                if (!this.hasParticipantAudioOverrides(normalized)) continue;
                next[id] = normalized;
            }
            this.state.participantAudioSettings = next;
        } catch (_) {
            this.state.participantAudioSettings = {};
        }
        return this.state.participantAudioSettings;
    },

    persistParticipantAudioSettings() {
        const meetingId = this.getParticipantAudioSettingsMeetingId();
        if (!meetingId) return;
        try {
            const raw = String(window?.localStorage?.getItem(PARTICIPANT_AUDIO_SETTINGS_STORAGE_KEY) || '').trim();
            const parsed = raw ? JSON.parse(raw) : {};
            const store = parsed && typeof parsed === 'object' ? parsed : {};
            const nextMeetingSettings = {};
            for (const [participantId, value] of Object.entries(this.state.participantAudioSettings || {})) {
                const id = String(participantId || '').trim();
                if (!id) continue;
                const normalized = this.normalizeParticipantAudioSettings(value);
                if (!this.hasParticipantAudioOverrides(normalized)) continue;
                nextMeetingSettings[id] = normalized;
            }
            if (Object.keys(nextMeetingSettings).length) {
                store[meetingId] = nextMeetingSettings;
            } else {
                delete store[meetingId];
            }
            window?.localStorage?.setItem(PARTICIPANT_AUDIO_SETTINGS_STORAGE_KEY, JSON.stringify(store));
        } catch (_) {
            // ignore storage failures
        }
    },

    getParticipantAudioSettings(participantId) {
        const id = String(participantId || '').trim();
        if (!id) {
            return this.normalizeParticipantAudioSettings({});
        }
        const current = this.state.participantAudioSettings && typeof this.state.participantAudioSettings === 'object'
            ? this.state.participantAudioSettings[id]
            : null;
        return this.normalizeParticipantAudioSettings(current);
    },

    setParticipantAudioSettings(participantId, settings) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const normalized = this.normalizeParticipantAudioSettings(settings);
        this.state.participantAudioSettings = {
            ...(this.state.participantAudioSettings || {})
        };
        if (this.hasParticipantAudioOverrides(normalized)) {
            this.state.participantAudioSettings[id] = normalized;
        } else {
            delete this.state.participantAudioSettings[id];
        }
        this.persistParticipantAudioSettings();
        this.remoteAudioNormalizer?.refreshParticipant?.(id);
    },

    getParticipantAudioState(participant) {
        const participantId = String(participant?.identity || participant || '').trim();
        const participantView = this.participantLayoutController.getParticipantView?.(participantId) || null;
        const isLocal = participant?.kind === 'local' || Boolean(participantView?.isLocal);
        const settings = this.getParticipantAudioSettings(participantId);
        return {
            canConfigureAudio: !isLocal && Boolean(participantId),
            hasCustomAudioSettings: !isLocal && this.hasParticipantAudioOverrides(settings),
            isAudioMutedLocally: !isLocal && Boolean(settings.muted)
        };
    },

    normalizeCameraQuality(value) {
        const quality = String(value || '').trim();
        return ['h360', 'h540', 'h720', 'h1080'].includes(quality) ? quality : 'h720';
    },

    normalizeScreenShareQuality(value) {
        const quality = String(value || '').trim();
        return ['h720fps15', 'h720fps30', 'h1080fps15', 'h1080fps30'].includes(quality)
            ? quality
            : 'h1080fps30';
    },

    formatPercent(value) {
        return `${Math.round(Number(value || 0) * 100)}%`;
    },

    getCurrentOutputVolume() {
        if (this.outputVolumeInput) {
            return this.normalizeOutputVolume(this.outputVolumeInput.value);
        }
        return this.normalizeOutputVolume(this.state.mediaSettings.outputVolume);
    },

    applyOutputVolumePreviewToElement(mediaElement, outputVolume = this.getCurrentOutputVolume()) {
        if (!mediaElement) return;
        const participantId = String(mediaElement.dataset?.participantId || '').trim();
        const participantSettings = this.getParticipantAudioSettings(participantId);
        const volume = this.normalizeOutputVolume(
            this.normalizeOutputVolume(outputVolume)
            * this.normalizeParticipantAudioVolume(participantSettings.volume)
            * (this.remoteAudioNormalizer?.getMultiplier?.(mediaElement) || 1)
        );
        const isDeafened = Boolean(this.state.mediaDeafened);
        mediaElement.volume = isDeafened ? 0 : volume;
        mediaElement.muted = isDeafened || Boolean(participantSettings.muted) || volume === 0;
        mediaElement.dataset.webmeetOutputVolume = String(this.normalizeOutputVolume(outputVolume));
        mediaElement.dataset.webmeetParticipantVolume = String(participantSettings.volume);
        mediaElement.dataset.webmeetParticipantMuted = participantSettings.muted ? 'true' : 'false';
        mediaElement.dataset.webmeetAutomaticMultiplier = String(this.remoteAudioNormalizer?.getMultiplier?.(mediaElement) || 1);
        mediaElement.dataset.webmeetDeafened = isDeafened ? 'true' : 'false';
    },

    applyOutputVolumePreviewToAllAudioElements(outputVolume = this.getCurrentOutputVolume()) {
        const handled = new Set();
        for (const entry of this.participantLayoutController.getTrackEntries()) {
            if (entry?.kind !== 'audio' || !entry.element) continue;
            this.applyOutputVolumePreviewToElement(entry.element, outputVolume);
            handled.add(entry.element);
        }
        for (const mediaElement of this.element.querySelectorAll('audio')) {
            if (handled.has(mediaElement)) continue;
            this.applyOutputVolumePreviewToElement(mediaElement, outputVolume);
        }
    },

    applyParticipantAudioSettingsToParticipant(participantId, outputVolume = this.getCurrentOutputVolume()) {
        const id = String(participantId || '').trim();
        if (!id) return;
        let applied = false;
        for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(id, { kind: 'audio' })) {
            const trackEntry = this.participantLayoutController.getTrackEntry(trackId);
            if (!trackEntry?.element) continue;
            trackEntry.element.dataset.participantId = id;
            this.applyOutputVolumePreviewToElement(trackEntry.element, outputVolume);
            applied = true;
        }
        for (const mediaElement of this.element.querySelectorAll('audio')) {
            const elementParticipantId = String(
                mediaElement.dataset?.participantId
                || mediaElement.closest?.('[data-participant-id]')?.dataset?.participantId
                || ''
            ).trim();
            if (elementParticipantId !== id) continue;
            mediaElement.dataset.participantId = id;
            this.applyOutputVolumePreviewToElement(mediaElement, outputVolume);
            applied = true;
        }
        this.participantLayoutController.refreshParticipantAudioState?.(id);
        return applied;
    },

    previewParticipantAudioSettings(settings = {}) {
        const participantId = String(settings.participantId || '').trim();
        if (!participantId) return;
        this.setParticipantAudioSettings(participantId, {
            muted: settings.muted,
            volume: settings.volume
        });
        this.applyParticipantAudioSettingsToParticipant(participantId);
    },

    handleParticipantAudioPreview(event) {
        this.previewParticipantAudioSettings(event?.detail || {});
    },

    normalizeDeviceLabel(label) {
        return String(label || '')
            .toLowerCase()
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\b(default|communications|input|output|device|microphone|speaker|headphones|headset|built-in|analog|stereo)\b/g, ' ')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();
    },

    isDefaultDevice(device) {
        const id = String(device?.deviceId || '').toLowerCase();
        const label = String(device?.label || '').toLowerCase();
        return id === 'default' || id === 'communications' || /\b(default|communications)\b/.test(label);
    },

    findSelectedDevice(devices, selectedId) {
        const id = String(selectedId || '').trim();
        if (!id) return null;
        return (Array.isArray(devices) ? devices : []).find((device) => device.deviceId === id) || null;
    },

    countConcreteDevices(devices) {
        const ids = new Set();
        for (const device of Array.isArray(devices) ? devices : []) {
            const id = String(device?.deviceId || '').trim();
            if (!id || this.isDefaultDevice(device)) continue;
            ids.add(id);
        }
        return ids.size;
    },

    hasAmbiguousAudioDevices(devices) {
        const byLabel = new Map();
        for (const device of Array.isArray(devices) ? devices : []) {
            if (!device || this.isDefaultDevice(device)) continue;
            const key = this.normalizeDeviceLabel(device.label);
            if (!key) continue;
            byLabel.set(key, (byLabel.get(key) || 0) + 1);
        }
        return [...byLabel.values()].some((count) => count > 1);
    },

    getStaticMediaDeviceWarnings(settings = this.state.mediaSettings) {
        const warnings = [];
        const audioInputs = this.mediaDevices.audioInput || [];
        const audioOutputs = this.mediaDevices.audioOutput || [];
        const selectedInputId = String(settings.audioInputDeviceId || '').trim();
        const selectedOutputId = String(settings.audioOutputDeviceId || '').trim();
        const selectedInput = this.findSelectedDevice(audioInputs, selectedInputId);
        const selectedOutput = this.findSelectedDevice(audioOutputs, selectedOutputId);
        const microphoneGain = this.normalizeMicrophoneGain(settings.microphoneGain);
        const outputVolume = this.normalizeOutputVolume(settings.outputVolume);
        const voiceProcessingMode = this.normalizeVoiceProcessingMode(settings.voiceProcessingMode);
        const concreteInputCount = this.countConcreteDevices(audioInputs);
        const concreteOutputCount = this.countConcreteDevices(audioOutputs);
        const canSelectOutput = typeof HTMLMediaElement !== 'undefined'
            && typeof HTMLMediaElement.prototype?.setSinkId === 'function';
    
        if (!audioInputs.length) {
            warnings.push('No microphone was detected by the browser.');
        } else if (selectedInputId && !selectedInput) {
            warnings.push('The selected microphone is no longer available. Select another microphone.');
        } else if ((!selectedInputId || this.isDefaultDevice(selectedInput)) && concreteInputCount > 1) {
            warnings.push('Multiple microphones are available. Select the exact microphone to avoid device conflicts.');
        }
        if (this.hasAmbiguousAudioDevices(audioInputs)) {
            warnings.push('Some microphones have matching labels. Test the selected input before speaking.');
        }
        if (microphoneGain === 0) {
            warnings.push('Microphone volume is set to 0% in WebMeet.');
        } else if (microphoneGain > 1.25) {
            warnings.push('Microphone volume is boosted above 125%; audio can distort.');
        }
        if (voiceProcessingMode === 'enhanced' && !(globalThis.AudioWorkletNode && globalThis.navigator?.mediaDevices?.getUserMedia)) {
            warnings.push('Enhanced voice processing is not supported in this browser. WebMeet will use standard microphone processing.');
        }
    
        if (!canSelectOutput && selectedOutputId) {
            warnings.push('This browser cannot route audio to a selected speaker. It will use the system default output.');
        } else if (canSelectOutput && selectedOutputId && !selectedOutput) {
            warnings.push('The selected speaker is no longer available. Select another speaker.');
        } else if (canSelectOutput && (!selectedOutputId || this.isDefaultDevice(selectedOutput)) && concreteOutputCount > 1) {
            warnings.push('Multiple speakers are available. Select the exact output to avoid using the wrong device.');
        }
        if (outputVolume === 0) {
            warnings.push('Speaker volume is set to 0% in WebMeet.');
        }
    
        return [...new Set(warnings)];
    },

    async collectMicrophoneSignalWarnings(settings = this.state.mediaSettings) {
        if (this.normalizeMicrophoneGain(settings.microphoneGain) === 0) {
            return [];
        }
        if (!navigator?.mediaDevices?.getUserMedia) {
            return ['Microphone signal cannot be tested in this browser.'];
        }
        const AudioContextRef = globalThis.AudioContext || globalThis.webkitAudioContext || null;
        if (!AudioContextRef) {
            return ['Microphone signal cannot be tested because audio processing is unavailable.'];
        }
    
        let stream = null;
        let ownedStream = false;
        let audioContext = null;
        let sourceNode = null;
        try {
            const activeTrack = this.mediaController.getActiveMicrophoneMediaStreamTrack?.();
            if (activeTrack) {
                stream = new MediaStream([activeTrack]);
            } else {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: this.mediaController.getMicrophoneEnableOptions(),
                    video: false
                });
                ownedStream = true;
            }
            audioContext = new AudioContextRef({ sampleRate: 48000 });
            if (audioContext.state === 'suspended') {
                try { await audioContext.resume(); } catch (_) {}
            }
            sourceNode = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 1024;
            sourceNode.connect(analyser);
            const samples = new Uint8Array(analyser.fftSize);
            let peak = 0;
            const readPeak = () => {
                analyser.getByteTimeDomainData(samples);
                let sum = 0;
                for (const sample of samples) {
                    const value = (sample - 128) / 128;
                    sum += value * value;
                }
                peak = Math.max(peak, Math.sqrt(sum / samples.length));
            };
            for (let index = 0; index < 6; index += 1) {
                readPeak();
                await new Promise((resolve) => setTimeout(resolve, 90));
            }
            if (peak < 0.004) {
                return ['No microphone signal was detected during the quick check. If you were speaking, check OS input volume, mute switch, or selected microphone.'];
            }
        } catch (error) {
            const name = String(error?.name || '').trim();
            if (name === 'NotAllowedError' || name === 'SecurityError') {
                return ['Microphone permission is blocked, so WebMeet cannot verify the selected input.'];
            }
            if (name === 'NotFoundError' || name === 'OverconstrainedError') {
                return ['The selected microphone cannot be opened. Select another input device.'];
            }
            if (name === 'NotReadableError') {
                return ['The selected microphone is busy or blocked by the operating system. Close other apps or select another input.'];
            }
            return ['Microphone signal could not be verified. Check the selected device and OS input settings.'];
        } finally {
            try { sourceNode?.disconnect?.(); } catch (_) {}
            try { await audioContext?.close?.(); } catch (_) {}
            if (ownedStream) {
                for (const track of stream?.getTracks?.() || []) {
                    try { track.stop(); } catch (_) {}
                }
            }
        }
        return [];
    },

    async collectMediaDeviceWarnings(settings = this.getCurrentMediaSettingsForPanel(), options = {}) {
        const warnings = this.getStaticMediaDeviceWarnings(settings);
        if (options.testMicrophone) {
            warnings.push(...await this.collectMicrophoneSignalWarnings(settings));
        }
        return [...new Set(warnings)];
    },

    persistMediaSettings() {
        try {
            window?.localStorage?.setItem(MEDIA_SETTINGS_STORAGE_KEY, JSON.stringify(this.state.mediaSettings));
        } catch (_) {
            // ignore storage failures
        }
    },

    async refreshMediaDevices(options = {}) {
        const requestPermission = options.requestPermission === undefined ? true : Boolean(options.requestPermission);
        const requestAudioPermission = options.requestAudioPermission === undefined ? requestPermission : Boolean(options.requestAudioPermission);
        const requestVideoPermission = options.requestVideoPermission === undefined ? false : Boolean(options.requestVideoPermission);
        const showToast = options.showToast === undefined ? true : Boolean(options.showToast);
        if (!navigator?.mediaDevices?.enumerateDevices) {
            this.setError('Media device enumeration is not supported in this browser.');
            return;
        }
        try {
            if ((requestAudioPermission || requestVideoPermission) && navigator?.mediaDevices?.getUserMedia) {
                try {
                    const stream = await navigator.mediaDevices.getUserMedia({
                        audio: requestAudioPermission,
                        video: requestVideoPermission
                    });
                    for (const track of stream.getTracks()) {
                        try { track.stop(); } catch (_) {}
                    }
                } catch (_) {
                    // ignore permission refusal and still enumerate what is available
                }
            }
            const devices = await navigator.mediaDevices.enumerateDevices();
            this.mediaDevices = {
                audioInput: devices.filter((d) => d.kind === 'audioinput'),
                videoInput: devices.filter((d) => d.kind === 'videoinput'),
                audioOutput: devices.filter((d) => d.kind === 'audiooutput')
            };
            this.state.mediaDeviceWarnings = await this.collectMediaDeviceWarnings(
                this.getCurrentMediaSettingsForPanel(),
                { testMicrophone: requestAudioPermission }
            );
        } catch (_) {
            this.mediaDevices = { audioInput: [], videoInput: [], audioOutput: [] };
            this.state.mediaDeviceWarnings = ['Failed to refresh media devices.'];
            this.setError('Failed to refresh media devices.');
            return;
        }
        this.renderMediaSettingsPanel();
        if (showToast) {
            const ai = this.mediaDevices.audioInput.length;
            const vi = this.mediaDevices.videoInput.length;
            const ao = this.mediaDevices.audioOutput.length;
            const warning = this.state.mediaDeviceWarnings[0]
                ? ` ${this.state.mediaDeviceWarnings[0]}`
                : '';
            this.setError(`Devices refreshed: ${ai} microphones, ${vi} cameras, ${ao} speakers.${warning}`);
        }
    },

    renderMediaDeviceOptions(selectElement, devices, selectedId, emptyLabel) {
        if (!selectElement) return;
        const safeDevices = Array.isArray(devices) ? devices : [];
        const options = ['<option value="">Default</option>'];
        for (const device of safeDevices) {
            const id = escapeHtml(String(device.deviceId || '').trim());
            const label = escapeHtml(String(device.label || `${emptyLabel} ${safeDevices.indexOf(device) + 1}`));
            options.push(`<option value="${id}">${label}</option>`);
        }
        selectElement.innerHTML = options.join('');
        selectElement.value = String(selectedId || '');
    },

    setSettingsTab(target) {
        const source = target?.target || target;
        const tabElement = source?.closest?.('[data-settings-tab]') || source;
        const tab = String(tabElement?.dataset?.settingsTab || '').trim();
        this.state.activeSettingsTab = tab === 'avatar' ? 'avatar' : 'media';
        this.renderMediaSettingsPanel();
    },

    renderMediaSettingsPanel() {
        const settings = this.getCurrentMediaSettingsForPanel();
        const activeSettingsTab = this.state.activeSettingsTab === 'avatar' ? 'avatar' : 'media';
        for (const button of this.settingsTabButtons || []) {
            const isActive = String(button.dataset?.settingsTab || '').trim() === activeSettingsTab;
            button.classList.toggle('is-active', isActive);
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
            button.tabIndex = isActive ? 0 : -1;
        }
        for (const panel of this.settingsTabPanels || []) {
            const isActive = String(panel.dataset?.settingsTabPanel || '').trim() === activeSettingsTab;
            panel.hidden = !isActive;
        }
        this.mediaSettingsActions?.classList.toggle('webmeet-hidden', activeSettingsTab !== 'media');
        this.avatarSettingsActions?.classList.toggle('webmeet-hidden', activeSettingsTab !== 'avatar');
        const syncSelectOptions = (selectElement, devices, selectedId, emptyLabel) => {
            if (!selectElement) return;
            const currentValue = String(selectElement.value || '').trim();
            const shouldPreserveCurrentValue = this.state.mediaSettingsPanelVisible
                && this.state.mediaSettingsDraft
                && currentValue === String(selectedId || '').trim();
            this.renderMediaDeviceOptions(
                selectElement,
                devices,
                shouldPreserveCurrentValue ? currentValue : selectedId,
                emptyLabel
            );
        };
        syncSelectOptions(this.audioInputSelect, this.mediaDevices.audioInput, settings.audioInputDeviceId, 'Microphone');
        syncSelectOptions(this.videoInputSelect, this.mediaDevices.videoInput, settings.videoInputDeviceId, 'Camera');
        syncSelectOptions(this.audioOutputSelect, this.mediaDevices.audioOutput, settings.audioOutputDeviceId, 'Speaker');
        if (this.cameraQualitySelect) this.cameraQualitySelect.value = this.normalizeCameraQuality(settings.cameraQuality);
        if (this.screenShareQualitySelect) this.screenShareQualitySelect.value = this.normalizeScreenShareQuality(settings.screenShareQuality);
        if (this.backgroundEffectSelect) this.backgroundEffectSelect.value = this.normalizeBackgroundMode(settings.backgroundMode);
        if (this.echoCancellationInput && document.activeElement !== this.echoCancellationInput) {
            this.echoCancellationInput.checked = Boolean(settings.echoCancellation);
        }
        if (this.noiseSuppressionInput && document.activeElement !== this.noiseSuppressionInput) {
            this.noiseSuppressionInput.checked = Boolean(settings.noiseSuppression);
        }
        if (this.autoGainControlInput && document.activeElement !== this.autoGainControlInput) {
            this.autoGainControlInput.checked = Boolean(settings.autoGainControl);
        }
        if (this.automaticParticipantVolumeInput && document.activeElement !== this.automaticParticipantVolumeInput) {
            this.automaticParticipantVolumeInput.checked = settings.automaticParticipantVolume !== false;
        }
        if (this.voiceProcessingModeSelect && document.activeElement !== this.voiceProcessingModeSelect) {
            this.voiceProcessingModeSelect.value = this.normalizeVoiceProcessingMode(settings.voiceProcessingMode);
        }
        if (this.humFilterSelect && document.activeElement !== this.humFilterSelect) {
            this.humFilterSelect.value = this.normalizeHumFilter(settings.humFilter);
        }
        const microphoneGain = this.normalizeMicrophoneGain(settings.microphoneGain);
        const outputVolume = this.normalizeOutputVolume(settings.outputVolume);
        if (this.microphoneGainInput && document.activeElement !== this.microphoneGainInput) {
            this.microphoneGainInput.value = String(microphoneGain);
        }
        if (this.microphoneGainValue) this.microphoneGainValue.textContent = this.formatPercent(microphoneGain);
        if (this.microphoneGainWarning) {
            this.microphoneGainWarning.classList.toggle('webmeet-hidden', microphoneGain <= 1.25);
        }
        if (this.outputVolumeInput && document.activeElement !== this.outputVolumeInput) {
            this.outputVolumeInput.value = String(outputVolume);
        }
        if (this.outputVolumeValue) this.outputVolumeValue.textContent = this.formatPercent(outputVolume);
        if (this.roomNotificationSoundsInput && document.activeElement !== this.roomNotificationSoundsInput) {
            this.roomNotificationSoundsInput.checked = settings.roomNotificationSounds !== false;
        }
        const backgroundBlurRadius = this.normalizeBackgroundBlurRadius(settings.backgroundBlurRadius);
        if (this.backgroundBlurInput && document.activeElement !== this.backgroundBlurInput) {
            this.backgroundBlurInput.value = String(backgroundBlurRadius);
        }
        if (this.backgroundBlurValue) {
            this.backgroundBlurValue.textContent = `${backgroundBlurRadius}px`;
        }
        const backgroundMode = this.normalizeBackgroundMode(settings.backgroundMode);
        const hasBackgroundImage = Boolean(settings.backgroundImageDataUrl);
        this.backgroundBlurRow?.classList.toggle('webmeet-hidden', backgroundMode !== 'blur');
        this.backgroundImageRow?.classList.toggle('webmeet-hidden', backgroundMode !== 'image');
        this.backgroundImageWarning?.classList.toggle('webmeet-hidden', !(backgroundMode === 'image' && !hasBackgroundImage));
        if (this.backgroundImagePreview) {
            this.backgroundImagePreview.classList.toggle('webmeet-hidden', !(backgroundMode === 'image' && hasBackgroundImage));
        }
        if (this.backgroundImagePreviewImage) {
            if (backgroundMode === 'image' && hasBackgroundImage) {
                this.backgroundImagePreviewImage.src = settings.backgroundImageDataUrl;
                this.backgroundImagePreviewImage.alt = settings.backgroundImageName || 'Selected virtual background';
            } else {
                this.backgroundImagePreviewImage.removeAttribute('src');
                this.backgroundImagePreviewImage.alt = '';
            }
        }
        if (this.backgroundImageName) {
            this.backgroundImageName.textContent = hasBackgroundImage
                ? (settings.backgroundImageName || 'Custom background')
                : 'No image selected';
        }
        if (this.backgroundImageRemoveButton) {
            this.backgroundImageRemoveButton.classList.toggle('webmeet-hidden', !hasBackgroundImage);
        }
        if (this.mediaDeviceWarnings) {
            const warnings = Array.isArray(this.state.mediaDeviceWarnings) ? this.state.mediaDeviceWarnings : [];
            this.mediaDeviceWarnings.classList.toggle('webmeet-hidden', warnings.length === 0);
            this.mediaDeviceWarnings.innerHTML = warnings
                .map((warning) => `<p class="webmeet-media-device-warning">${escapeHtml(warning)}</p>`)
                .join('');
        }
        this.updateAudioHealthIndicator?.();
        if (this.mediaSettingsPanel) {
            this.mediaSettingsPanel.classList.toggle('webmeet-hidden', !this.state.mediaSettingsPanelVisible);
        }
        if (this.mediaSettingsButton) {
            this.mediaSettingsButton.classList.toggle('active', this.state.mediaSettingsPanelVisible);
        }
        if (this.applyMediaSettingsButton) {
            const isApplying = Boolean(this.state.mediaSettingsApplying);
            this.applyMediaSettingsButton.classList.toggle('is-loading', isApplying);
            this.applyMediaSettingsButton.disabled = isApplying;
            this.applyMediaSettingsButton.setAttribute('aria-busy', isApplying ? 'true' : 'false');
        }
        this.renderAvatarControls?.();
    },

    toggleMediaSettings() {
        if (this.state.mediaSettingsApplying) {
            return;
        }
        if (this.state.mediaSettingsPanelVisible) {
            this.closeMediaSettings();
            return;
        }
        this.state.mediaSettingsPanelVisible = true;
        this.beginMediaSettingsDraft();
        this.state.webMeetAvatarOverrideDraft = this.state.webMeetAvatarOverride;
        this.state.activeMobilePanel = 'room';
        this.applyMobilePanelState?.();
        this.renderMediaSettingsPanel();
        window.addEventListener('webmeet:settings-modal-ready', this.handleSettingsModalReadyEvent);
        window.addEventListener('webmeet:settings-modal-action', this.handleSettingsModalActionEvent);
        window.addEventListener('webmeet:settings-modal-closed', this.handleSettingsModalClosedEvent);
        Promise.resolve(globalThis.assistOS?.UI?.showModal?.('webmeet-settings-modal')).catch(() => {
            this.state.mediaSettingsPanelVisible = false;
            this.clearMediaSettingsDraft();
            this.renderMediaSettingsPanel();
        });
    },

    closeMediaSettings() {
        if (this.state.mediaSettingsApplying || !this.state.mediaSettingsPanelVisible) {
            return;
        }
        this.state.mediaSettingsPanelVisible = false;
        this.clearMediaSettingsDraft();
        this.state.activeMobilePanel = 'room';
        this.applyMobilePanelState?.();
        this.closeMediaSettingsDialog();
        this.renderMediaSettingsPanel();
    },

    mountMediaSettingsModal(event) {
        const detail = event?.detail || {};
        if (!this.state.mediaSettingsPanelVisible || !detail.content || !this.mediaSettingsPanel) return;
        this.mediaSettingsModalElement = detail.element || null;
        detail.content.appendChild(this.mediaSettingsPanel);
        this.mediaSettingsPanel.classList.remove('webmeet-hidden');
        this.renderMediaSettingsPanel();
        void this.refreshMediaDevices({ requestPermission: false, showToast: false });
    },

    restoreMediaSettingsPanel() {
        if (!this.mediaSettingsPanel || !this.mediaSettingsMount) return;
        this.mediaSettingsMount.insertAdjacentElement('afterend', this.mediaSettingsPanel);
        this.mediaSettingsPanel.classList.add('webmeet-hidden');
    },

    closeMediaSettingsDialog(payload = null) {
        const modalElement = this.mediaSettingsModalElement;
        this.restoreMediaSettingsPanel();
        this.mediaSettingsModalElement = null;
        window.removeEventListener('webmeet:settings-modal-ready', this.handleSettingsModalReadyEvent);
        window.removeEventListener('webmeet:settings-modal-action', this.handleSettingsModalActionEvent);
        window.removeEventListener('webmeet:settings-modal-closed', this.handleSettingsModalClosedEvent);
        if (modalElement?.isConnected) {
            globalThis.assistOS?.UI?.closeModal?.(modalElement, payload);
        }
    },

    handleMediaSettingsModalClosed() {
        this.restoreMediaSettingsPanel();
        this.mediaSettingsModalElement = null;
        window.removeEventListener('webmeet:settings-modal-ready', this.handleSettingsModalReadyEvent);
        window.removeEventListener('webmeet:settings-modal-action', this.handleSettingsModalActionEvent);
        window.removeEventListener('webmeet:settings-modal-closed', this.handleSettingsModalClosedEvent);
        this.state.mediaSettingsPanelVisible = false;
        this.clearMediaSettingsDraft();
        this.renderMediaSettingsPanel();
    },

    handleMediaSettingsModalAction(event) {
        const action = String(event?.detail?.action || '').trim();
        const allowedActions = new Set([
            'closeMediaSettings',
            'applyMediaSettings',
            'setSettingsTab',
            'refreshMediaDevices',
            'resetWebMeetAvatarOverride',
            'applyWebMeetAvatarSettings'
        ]);
        if (!allowedActions.has(action) || typeof this[action] !== 'function') return;
        void this[action](event?.detail?.target);
    },

    collectMediaSettingsFromInputs(baseInputSettings = this.state.mediaSettingsDraft || this.state.mediaSettings) {
        const baseSettings = this.normalizeMediaSettings(baseInputSettings);
        return this.normalizeMediaSettings({
            audioInputDeviceId: String(this.audioInputSelect?.value || '').trim(),
            videoInputDeviceId: String(this.videoInputSelect?.value || '').trim(),
            audioOutputDeviceId: String(this.audioOutputSelect?.value || '').trim(),
            echoCancellation: Boolean(this.echoCancellationInput?.checked),
            noiseSuppression: Boolean(this.noiseSuppressionInput?.checked),
            autoGainControl: Boolean(this.autoGainControlInput?.checked),
            automaticParticipantVolume: this.automaticParticipantVolumeInput?.checked !== false,
            microphoneGain: this.normalizeMicrophoneGain(this.microphoneGainInput?.value),
            voiceProcessingMode: this.normalizeVoiceProcessingMode(this.voiceProcessingModeSelect?.value),
            humFilter: this.normalizeHumFilter(this.humFilterSelect?.value),
            outputVolume: this.normalizeOutputVolume(this.outputVolumeInput?.value),
            roomNotificationSounds: this.roomNotificationSoundsInput?.checked !== false,
            cameraQuality: this.normalizeCameraQuality(this.cameraQualitySelect?.value),
            screenShareQuality: this.normalizeScreenShareQuality(this.screenShareQualitySelect?.value),
            backgroundMode: this.normalizeBackgroundMode(this.backgroundEffectSelect?.value || baseSettings.backgroundMode),
            backgroundBlurRadius: this.normalizeBackgroundBlurRadius(this.backgroundBlurInput?.value || baseSettings.backgroundBlurRadius),
            backgroundImageDataUrl: baseSettings.backgroundImageDataUrl,
            backgroundImageName: baseSettings.backgroundImageName
        });
    },

    async applyAudioOutputDeviceToElement(mediaElement) {
        const outputId = String(this.state.mediaSettings.audioOutputDeviceId || '').trim();
        if (!mediaElement) {
            return;
        }
        if (!String(mediaElement.dataset?.participantId || '').trim()) {
            mediaElement.dataset.participantId = String(mediaElement.closest?.('[data-participant-id]')?.dataset?.participantId || '').trim();
        }
        this.applyOutputVolumePreviewToElement(mediaElement, this.getCurrentOutputVolume());
        if (typeof mediaElement.setSinkId === 'function') {
            try {
                await mediaElement.setSinkId(outputId || '');
            } catch (_) {
                if (outputId) {
                    this.setError('Selected speaker could not be used. WebMeet is using the browser default output.');
                }
            }
        }
    },

    async applyAudioOutputDeviceToAllTracks() {
        const entries = this.participantLayoutController.getTrackEntries();
        const tasks = [];
        for (const entry of entries) {
            if (entry?.kind !== 'audio' || !entry.element) continue;
            tasks.push(this.applyAudioOutputDeviceToElement(entry.element));
        }
        await Promise.allSettled(tasks);
    },

    hasSettingsChange(previousSettings, keys = []) {
        const before = this.normalizeMediaSettings(previousSettings);
        const after = this.normalizeMediaSettings(this.state.mediaSettings);
        return keys.some((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
    },

    async reapplyActiveInputDevices(previousSettings = this.state.mediaSettings) {
        const errors = [];
        if (!this.room?.localParticipant) return errors;
        const shouldRestartMicrophone = this.state.media.microphone && this.hasSettingsChange(previousSettings, [
            'audioInputDeviceId',
            'echoCancellation',
            'noiseSuppression',
            'autoGainControl',
            'microphoneGain',
            'voiceProcessingMode',
            'humFilter'
        ]);
        const shouldRestartCamera = this.state.media.camera && this.hasSettingsChange(previousSettings, [
            'videoInputDeviceId',
            'cameraQuality'
        ]);
        const shouldRefreshBackground = this.state.media.camera && this.hasSettingsChange(previousSettings, [
            'backgroundMode',
            'backgroundBlurRadius',
            'backgroundImageDataUrl'
        ]);
        const shouldRestartScreenShare = this.state.media.screen && this.hasSettingsChange(previousSettings, [
            'screenShareQuality'
        ]);
        if (shouldRestartMicrophone) {
            await this.runMediaToggleWithLoading('microphone', () => this.mediaController.restartMicrophone());
        }
        if (shouldRestartCamera) {
            try {
                await this.room.localParticipant.setCameraEnabled(false);
                const camOptions = this.mediaController.getCameraEnableOptions();
                const publishOptions = this.mediaController.getCameraPublishOptions();
                try {
                    await this.room.localParticipant.setCameraEnabled(true, camOptions, publishOptions);
                } catch (_) {
                    await this.room.localParticipant.setCameraEnabled(true);
                    errors.push('Selected camera settings could not be used. WebMeet is using browser default camera settings.');
                }
            } catch (error) {
                errors.push(error instanceof Error ? error.message : 'Camera settings could not be applied.');
            }
        }
        if (this.state.media.camera && (shouldRestartCamera || shouldRefreshBackground)) {
            try {
                await this.mediaController.syncBackgroundEffect();
            } catch (error) {
                errors.push(error instanceof Error ? error.message : 'Background privacy settings could not be applied.');
            }
        }
        if (shouldRestartScreenShare) {
            try {
                await this.room.localParticipant.setScreenShareEnabled(false);
                await this.room.localParticipant.setScreenShareEnabled(
                    true,
                    this.mediaController.getScreenShareQualityOptions(),
                    this.mediaController.getScreenSharePublishOptions()
                );
            } catch (error) {
                errors.push(error instanceof Error ? error.message : 'Screen share settings could not be applied.');
            }
        }
        return errors;
    },

    async applyMediaSettings() {
        if (this.state.mediaSettingsApplying) {
            return;
        }
        const previousSettings = this.cloneCurrentMediaSettings();
        const nextSettings = this.state.mediaSettingsDraft
            ? this.normalizeMediaSettings(this.state.mediaSettingsDraft)
            : this.collectMediaSettingsFromInputs(previousSettings);
        const validationError = this.getMediaSettingsValidationError(nextSettings);
        if (validationError) {
            this.state.mediaSettingsDraft = nextSettings;
            this.renderMediaSettingsPanel();
            this.setError(validationError);
            return;
        }
        this.state.mediaSettingsApplying = true;
        this.state.mediaSettings = nextSettings;
        this.renderMediaSettingsPanel();
        try {
            this.mediaController.setSettings(this.state.mediaSettings);
            this.persistMediaSettings();
            if (this.hasSettingsChange(previousSettings, ['automaticParticipantVolume'])) {
                for (const participantId of this.participantLayoutController.getParticipantIds()) {
                    this.remoteAudioNormalizer?.refreshParticipant?.(participantId);
                }
                this.applyOutputVolumePreviewToAllAudioElements();
            }
            this.state.mediaDeviceWarnings = await this.collectMediaDeviceWarnings(
                this.state.mediaSettings,
                { testMicrophone: true }
            );
            await this.applyAudioOutputDeviceToAllTracks();
            const inputErrors = await this.reapplyActiveInputDevices(previousSettings);
            this.state.mediaSettingsPanelVisible = false;
            if (this.state.activeMobilePanel === 'settings') {
                this.state.activeMobilePanel = 'room';
                this.applyMobilePanelState?.();
            }
            this.clearMediaSettingsDraft();
            this.closeMediaSettingsDialog({ applied: true });
            this.renderMediaSettingsPanel();
            this.setError(inputErrors[0] || this.state.mediaDeviceWarnings[0] || 'Media settings applied.');
        } finally {
            this.state.mediaSettingsApplying = false;
            if (this.state.mediaSettingsPanelVisible) {
                this.renderMediaSettingsPanel();
            }
        }
    },

    async openParticipantAudioSettings(target) {
        const source = target?.target || target;
        const participantId = String(
            source?.dataset?.participantId
            || source?.closest?.('[data-participant-id]')?.dataset?.participantId
            || ''
        ).trim();
        if (!participantId) return;
        const participantView = this.participantLayoutController.getParticipantView?.(participantId) || null;
        if (!participantView || participantView.isLocal) {
            return;
        }
        const currentSettings = this.getParticipantAudioSettings(participantId);
        let result = null;
        if (globalThis.assistOS?.UI && typeof globalThis.assistOS.UI.showModal === 'function') {
            result = await globalThis.assistOS.UI.showModal('webmeet-participant-audio-modal', {
                participantId,
                participantName: participantView.name || participantId,
                volume: String(currentSettings.volume),
                muted: currentSettings.muted ? 'true' : 'false'
            }, true);
        } else {
            this.setError?.('Participant audio settings modal is unavailable.');
            return;
        }
        if (!result) return;
        const resultParticipantId = String(result.participantId || participantId).trim();
        if (result.reset === true) {
            this.setParticipantAudioSettings(resultParticipantId, { muted: false, volume: 1 });
        } else {
            this.setParticipantAudioSettings(resultParticipantId, {
                muted: result.muted,
                volume: result.volume
            });
        }
        this.applyParticipantAudioSettingsToParticipant(resultParticipantId);
        this.renderParticipantLayout();
    }
};
