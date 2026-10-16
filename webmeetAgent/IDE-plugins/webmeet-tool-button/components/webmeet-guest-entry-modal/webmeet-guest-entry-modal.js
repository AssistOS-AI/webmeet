export class WebmeetGuestEntryModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.initialDisplayName = this.readData('displayName', 'display-name');
        this.status = this.readData('status') || 'Enter your name to join this public room.';
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

    beforeRender() {}

    afterRender() {
        this.form = this.element.querySelector('#webmeetGuestEntryModalForm');
        this.nameInput = this.element.querySelector('#webmeetGuestEntryName');
        this.statusElement = this.element.querySelector('#webmeetGuestEntryStatus');
        if (this.nameInput) {
            this.nameInput.value = this.initialDisplayName;
            requestAnimationFrame(() => {
                this.nameInput?.focus?.();
                this.nameInput?.select?.();
            });
        }
        if (this.statusElement) {
            this.statusElement.textContent = this.status;
        }
        this.form?.addEventListener?.('submit', this.handleSubmit);
    }

    beforeUnload() {
        this.form?.removeEventListener?.('submit', this.handleSubmit);
    }

    closeModal() {
        assistOS.UI.closeModal(this.element, null);
    }

    handleSubmit = (event) => {
        event?.preventDefault?.();
        const displayName = String(this.nameInput?.value || '').trim();
        if (!displayName) {
            if (this.statusElement) {
                this.statusElement.textContent = 'Enter your name to join.';
                this.statusElement.classList.add('is-error');
            }
            this.nameInput?.focus?.();
            return;
        }
        this.result = { displayName };
        assistOS.UI.closeModal(this.element, this.result);
    };
}
