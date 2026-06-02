export class CreateRoomModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.result = null;
        this.invalidate();
    }

    beforeRender() {}

    closeModal() {
        assistOS.UI.closeModal(this.element, this.result);
    }

    confirmCreate() {
        const roomType = this.element.querySelector('input[name="roomType"]:checked')?.value || 'team';
        const roomTitle = this.element.querySelector('[data-id="roomTitleInput"]')?.value?.trim() || '';

        if (!roomTitle) {
            this.showError('Please enter a room title');
            return;
        }

        this.result = {
            roomType,
            roomTitle
        };
        assistOS.UI.closeModal(this.element, this.result);
    }

    showError(message) {
        const existingError = this.element.querySelector('.error-message');
        if (existingError) {
            existingError.remove();
        }

        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.textContent = message;
        errorDiv.style.cssText = 'color: #DB5C5C; font-size: 14px; margin-top: 8px;';

        const footer = this.element.querySelector('.modal-footer');
        if (footer) {
            footer.insertBefore(errorDiv, footer.firstChild);
        }

        setTimeout(() => {
            errorDiv.remove();
        }, 3000);
    }
}
