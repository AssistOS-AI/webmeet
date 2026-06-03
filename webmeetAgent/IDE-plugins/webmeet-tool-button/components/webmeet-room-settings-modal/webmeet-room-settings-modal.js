export class WebmeetRoomSettingsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.roomId = this.readData('roomId', 'room-id');
        this.roomTitle = this.readData('roomTitle', 'room-title') || 'Room';
        this.roomLink = this.readData('roomLink', 'room-link');
        this.result = null;
        this.invalidate();
    }

    readData(...names) {
        for (const name of names) {
            const value = String(this.element.getAttribute(`data-${name}`) || '').trim();
            if (value) return value;
        }
        return '';
    }

    beforeRender() {
        this.safeRoomId = this.roomId;
    }

    afterRender() {
        this.titleInput = this.element.querySelector('[data-role="roomTitleInput"]');
        this.copyButton = this.element.querySelector('[data-role="copyLinkButton"]');
        this.roomLinkText = this.element.querySelector('[data-role="roomLinkText"]');
        if (this.titleInput) {
            this.titleInput.value = this.roomTitle;
        }
        if (this.roomLinkText) {
            this.roomLinkText.textContent = this.roomLink;
        }
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }

    showError(message) {
        const target = this.element.querySelector('[data-role="roomSettingsError"]');
        if (!target) return;
        target.textContent = String(message || '').trim();
        target.hidden = !target.textContent;
    }

    async copyRoomLink() {
        if (!this.roomLink) {
            this.showError('Room link is unavailable.');
            return;
        }
        try {
            await navigator.clipboard.writeText(this.roomLink);
            const status = this.element.querySelector('[data-role="copyLinkStatus"]');
            if (status) {
                status.textContent = 'Copied';
                window.setTimeout(() => {
                    status.textContent = '';
                }, 1500);
            }
        } catch {
            this.showError(`Room link: ${this.roomLink}`);
        }
    }

    archiveRoom() {
        assistOS.UI.closeModal(this.element, {
            roomId: this.roomId,
            archive: true
        });
    }

    saveSettings() {
        const name = String(this.titleInput?.value || '').trim();
        if (!name) {
            this.showError('Room name is required.');
            return;
        }
        assistOS.UI.closeModal(this.element, {
            roomId: this.roomId,
            name
        });
    }
}
