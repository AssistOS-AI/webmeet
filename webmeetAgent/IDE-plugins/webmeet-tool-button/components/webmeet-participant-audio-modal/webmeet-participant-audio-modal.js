const DEFAULT_PARTICIPANT_VOLUME = 0.8;

export class WebmeetParticipantAudioModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.participantId = this.getDataAttribute('participantId', 'participant-id');
        this.participantName = this.getDataAttribute('participantName', 'participant-name') || 'Participant';
        this.initialVolume = this.normalizeVolume(this.element.getAttribute('data-volume'));
        this.initialMuted = String(this.element.getAttribute('data-muted') || '').toLowerCase() === 'true';
        this.result = null;
        this.invalidate();
    }

    getDataAttribute(...names) {
        for (const name of names) {
            const value = String(this.element.getAttribute(`data-${name}`) || '').trim();
            if (value) return value;
        }
        return '';
    }

    beforeRender() {
        this.volume = this.initialVolume;
        this.mutedChecked = this.initialMuted ? 'checked' : '';
    }

    afterRender() {
        this.volumeInput = this.element.querySelector('#webmeetParticipantAudioVolume');
        this.volumeValue = this.element.querySelector('[data-role="volumeValue"]');
        this.muteInput = this.element.querySelector('[data-role="muteInput"]');
        this.volumeInput?.addEventListener?.('input', this.handleVolumeInput);
        this.muteInput?.addEventListener?.('change', this.handleMuteChange);
        this.syncPreview();
    }

    normalizeVolume(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return DEFAULT_PARTICIPANT_VOLUME;
        return Math.min(1, Math.max(0, numberValue));
    }

    formatPercent(value) {
        return `${Math.round(this.normalizeVolume(value) * 100)}%`;
    }

    handleVolumeInput = () => {
        this.syncPreview();
        this.dispatchPreview();
    };

    handleMuteChange = () => {
        this.dispatchPreview();
    };

    syncPreview() {
        const volume = this.normalizeVolume(this.volumeInput?.value);
        if (this.volumeValue) {
            this.volumeValue.textContent = this.formatPercent(volume);
        }
    }

    getCurrentSettings() {
        return {
            participantId: this.participantId,
            volume: this.normalizeVolume(this.volumeInput?.value),
            muted: Boolean(this.muteInput?.checked)
        };
    }

    dispatchPreview(settings = this.getCurrentSettings()) {
        window.dispatchEvent(new CustomEvent('webmeet:participant-audio-preview', {
            detail: settings
        }));
    }

    closeModal() {
        this.dispatchPreview({
            participantId: this.participantId,
            volume: this.initialVolume,
            muted: this.initialMuted
        });
        assistOS.UI.closeModal(this.element, null);
    }

    resetSettings() {
        this.dispatchPreview({
            participantId: this.participantId,
            volume: DEFAULT_PARTICIPANT_VOLUME,
            muted: false
        });
        assistOS.UI.closeModal(this.element, {
            participantId: this.participantId,
            reset: true
        });
    }

    saveSettings() {
        const settings = this.getCurrentSettings();
        this.dispatchPreview(settings);
        assistOS.UI.closeModal(this.element, {
            participantId: settings.participantId,
            volume: settings.volume,
            muted: settings.muted
        });
    }
}
