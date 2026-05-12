export class WebmeetParticipantAudioModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.participantId = String(this.element.getAttribute('data-participantId') || '').trim();
        this.participantName = String(this.element.getAttribute('data-participantName') || 'Participant').trim() || 'Participant';
        this.initialVolume = this.normalizeVolume(this.element.getAttribute('data-volume'));
        this.initialMuted = String(this.element.getAttribute('data-muted') || '').toLowerCase() === 'true';
        this.result = null;
        this.invalidate();
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
        this.syncPreview();
    }

    normalizeVolume(value) {
        const numberValue = Number(value);
        if (!Number.isFinite(numberValue)) return 1;
        return Math.min(1, Math.max(0, numberValue));
    }

    formatPercent(value) {
        return `${Math.round(this.normalizeVolume(value) * 100)}%`;
    }

    handleVolumeInput = () => {
        this.syncPreview();
    };

    syncPreview() {
        const volume = this.normalizeVolume(this.volumeInput?.value);
        if (this.volumeValue) {
            this.volumeValue.textContent = this.formatPercent(volume);
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }

    resetSettings() {
        assistOS.UI.closeModal(this.element, {
            participantId: this.participantId,
            reset: true
        });
    }

    saveSettings() {
        assistOS.UI.closeModal(this.element, {
            participantId: this.participantId,
            volume: this.normalizeVolume(this.volumeInput?.value),
            muted: Boolean(this.muteInput?.checked)
        });
    }
}
