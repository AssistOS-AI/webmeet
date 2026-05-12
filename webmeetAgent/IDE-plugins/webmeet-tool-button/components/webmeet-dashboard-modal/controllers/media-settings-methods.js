function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

const PARTICIPANT_AUDIO_SETTINGS_STORAGE_KEY = 'webmeet.participantAudioSettings';

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
        const updateMicrophoneGainPreview = () => {
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
        };
        this.microphoneGainInput?.addEventListener?.('input', updateMicrophoneGainPreview);
        this.outputVolumeInput?.addEventListener?.('input', updateOutputVolumePreview);
        this.audioInputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.videoInputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.audioOutputSelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.cameraQualitySelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.screenShareQualitySelect?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.echoCancellationInput?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.echoCancellationInput?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.noiseSuppressionInput?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.noiseSuppressionInput?.addEventListener?.('input', handleSelectOrCheckboxChange);
        this.autoGainControlInput?.addEventListener?.('change', handleSelectOrCheckboxChange);
        this.autoGainControlInput?.addEventListener?.('input', handleSelectOrCheckboxChange);
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
            autoGainControl: true,
            microphoneGain: 1,
            outputVolume: 1,
            cameraQuality: 'h720',
            screenShareQuality: 'h1080fps30'
        };
        try {
            const raw = String(window?.localStorage?.getItem('webmeet.mediaSettings') || '').trim();
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                ...fallback,
                ...parsed,
                microphoneGain: this.normalizeMicrophoneGain(parsed?.microphoneGain),
                outputVolume: this.normalizeOutputVolume(parsed?.outputVolume),
                cameraQuality: this.normalizeCameraQuality(parsed?.cameraQuality),
                screenShareQuality: this.normalizeScreenShareQuality(parsed?.screenShareQuality)
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
            autoGainControl: settings.autoGainControl !== false,
            microphoneGain: this.normalizeMicrophoneGain(settings.microphoneGain),
            outputVolume: this.normalizeOutputVolume(settings.outputVolume),
            cameraQuality: this.normalizeCameraQuality(settings.cameraQuality),
            screenShareQuality: this.normalizeScreenShareQuality(settings.screenShareQuality)
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
        this.state.mediaSettingsDraft = this.collectMediaSettingsFromInputs();
    },

    normalizeMicrophoneGain(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return 1;
        return Math.min(2, Math.max(0, numberValue));
    },

    normalizeOutputVolume(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return 1;
        return Math.min(1, Math.max(0, numberValue));
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
            this.normalizeOutputVolume(outputVolume) * this.normalizeParticipantAudioVolume(participantSettings.volume)
        );
        mediaElement.volume = volume;
        mediaElement.muted = Boolean(participantSettings.muted) || volume === 0;
        mediaElement.dataset.webmeetOutputVolume = String(this.normalizeOutputVolume(outputVolume));
        mediaElement.dataset.webmeetParticipantVolume = String(participantSettings.volume);
        mediaElement.dataset.webmeetParticipantMuted = participantSettings.muted ? 'true' : 'false';
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
        for (const trackId of this.participantLayoutController.findTrackIdsForParticipant(id, { kind: 'audio' })) {
            const trackEntry = this.participantLayoutController.getTrackEntry(trackId);
            if (!trackEntry?.element) continue;
            trackEntry.element.dataset.participantId = id;
            this.applyOutputVolumePreviewToElement(trackEntry.element, outputVolume);
        }
        this.participantLayoutController.refreshParticipantAudioState?.(id);
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
            window?.localStorage?.setItem('webmeet.mediaSettings', JSON.stringify(this.state.mediaSettings));
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

    renderMediaSettingsPanel() {
        const settings = this.getCurrentMediaSettingsForPanel();
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
        if (this.echoCancellationInput && document.activeElement !== this.echoCancellationInput) {
            this.echoCancellationInput.checked = Boolean(settings.echoCancellation);
        }
        if (this.noiseSuppressionInput && document.activeElement !== this.noiseSuppressionInput) {
            this.noiseSuppressionInput.checked = Boolean(settings.noiseSuppression);
        }
        if (this.autoGainControlInput && document.activeElement !== this.autoGainControlInput) {
            this.autoGainControlInput.checked = Boolean(settings.autoGainControl);
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
        if (this.mediaDeviceWarnings) {
            const warnings = Array.isArray(this.state.mediaDeviceWarnings) ? this.state.mediaDeviceWarnings : [];
            this.mediaDeviceWarnings.classList.toggle('webmeet-hidden', warnings.length === 0);
            this.mediaDeviceWarnings.innerHTML = warnings
                .map((warning) => `<p class="webmeet-media-device-warning">${escapeHtml(warning)}</p>`)
                .join('');
        }
        if (this.mediaSettingsPanel) {
            this.mediaSettingsPanel.classList.toggle('webmeet-hidden', !this.state.mediaSettingsPanelVisible);
        }
        if (this.mediaSettingsButton) {
            this.mediaSettingsButton.classList.toggle('active', this.state.mediaSettingsPanelVisible);
        }
    },

    toggleMediaSettings() {
        this.state.mediaSettingsPanelVisible = !this.state.mediaSettingsPanelVisible;
        if (this.state.mediaSettingsPanelVisible) {
            this.beginMediaSettingsDraft();
            this.state.activeMobilePanel = 'settings';
            this.applyMobilePanelState?.();
        } else if (this.state.activeMobilePanel === 'settings') {
            this.clearMediaSettingsDraft();
            this.state.activeMobilePanel = 'room';
            this.applyMobilePanelState?.();
        }
        this.renderMediaSettingsPanel();
        if (this.state.mediaSettingsPanelVisible) {
            void this.refreshMediaDevices({ requestPermission: false, showToast: false });
        }
    },

    collectMediaSettingsFromInputs() {
        return this.normalizeMediaSettings({
            audioInputDeviceId: String(this.audioInputSelect?.value || '').trim(),
            videoInputDeviceId: String(this.videoInputSelect?.value || '').trim(),
            audioOutputDeviceId: String(this.audioOutputSelect?.value || '').trim(),
            echoCancellation: Boolean(this.echoCancellationInput?.checked),
            noiseSuppression: Boolean(this.noiseSuppressionInput?.checked),
            autoGainControl: Boolean(this.autoGainControlInput?.checked),
            microphoneGain: this.normalizeMicrophoneGain(this.microphoneGainInput?.value),
            outputVolume: this.normalizeOutputVolume(this.outputVolumeInput?.value),
            cameraQuality: this.normalizeCameraQuality(this.cameraQualitySelect?.value),
            screenShareQuality: this.normalizeScreenShareQuality(this.screenShareQualitySelect?.value)
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

    async reapplyActiveInputDevices() {
        if (!this.room?.localParticipant) return;
        if (this.state.media.microphone) {
            await this.runMediaToggleWithLoading('microphone', () => this.mediaController.restartMicrophone());
        }
        if (this.state.media.camera) {
            try {
                await this.room.localParticipant.setCameraEnabled(false);
                const camOptions = this.mediaController.getCameraEnableOptions();
                await this.room.localParticipant.setCameraEnabled(true, camOptions);
            } catch (_) {
                // ignore input restart errors
            }
        }
        if (this.state.media.screen) {
            try {
                await this.room.localParticipant.setScreenShareEnabled(false);
                await this.room.localParticipant.setScreenShareEnabled(
                    true,
                    this.mediaController.getScreenShareQualityOptions(),
                    this.mediaController.getScreenSharePublishOptions()
                );
            } catch (_) {
                // ignore screen restart errors
            }
        }
    },

    async applyMediaSettings() {
        this.state.mediaSettings = this.state.mediaSettingsDraft
            ? this.normalizeMediaSettings(this.state.mediaSettingsDraft)
            : this.collectMediaSettingsFromInputs();
        this.mediaController.setSettings(this.state.mediaSettings);
        this.persistMediaSettings();
        this.state.mediaDeviceWarnings = await this.collectMediaDeviceWarnings(
            this.state.mediaSettings,
            { testMicrophone: true }
        );
        await this.applyAudioOutputDeviceToAllTracks();
        await this.reapplyActiveInputDevices();
        this.state.mediaSettingsPanelVisible = false;
        this.clearMediaSettingsDraft();
        this.renderMediaSettingsPanel();
        this.setError(this.state.mediaDeviceWarnings[0] || 'Media settings applied.');
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
        const result = await assistOS.UI.showModal('webmeet-participant-audio-modal', {
            participantId,
            participantName: participantView.name || participantId,
            volume: String(currentSettings.volume),
            muted: currentSettings.muted ? 'true' : 'false'
        }, true);
        if (!result) return;
        if (result.reset === true) {
            this.setParticipantAudioSettings(participantId, { muted: false, volume: 1 });
        } else {
            this.setParticipantAudioSettings(participantId, {
                muted: result.muted,
                volume: result.volume
            });
        }
        this.applyParticipantAudioSettingsToParticipant(participantId);
        this.renderParticipantLayout();
    }
};
