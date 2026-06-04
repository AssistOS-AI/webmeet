const SETTINGS_ACTION_EVENT = 'webmeet:settings-modal-action';
const SETTINGS_READY_EVENT = 'webmeet:settings-modal-ready';
const SETTINGS_CLOSED_EVENT = 'webmeet:settings-modal-closed';

export class WebmeetSettingsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.dialogState = { isFullscreen: false, previous: null };
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.ensureResizable();
        window.dispatchEvent(new CustomEvent(SETTINGS_READY_EVENT, {
            detail: {
                element: this.element,
                content: this.element.querySelector('[data-role="settingsContent"]')
            }
        }));
    }

    afterUnload() {
        window.dispatchEvent(new CustomEvent(SETTINGS_CLOSED_EVENT, {
            detail: { element: this.element }
        }));
    }

    getDialogElement() {
        return this.element?.closest?.('dialog') || null;
    }

    ensureDialogPositioning() {
        const dialog = this.getDialogElement();
        if (!dialog || dialog.dataset.webmeetSettingsPositioned === 'true') return dialog;
        const rect = dialog.getBoundingClientRect();
        dialog.style.left = `${rect.left}px`;
        dialog.style.top = `${rect.top}px`;
        dialog.classList.add('webmeet-settings-positioned');
        dialog.dataset.webmeetSettingsPositioned = 'true';
        dialog.dataset.webmeetSettingsUserSized = 'false';
        return dialog;
    }

    startResize(event, direction) {
        const dialog = this.ensureDialogPositioning();
        if (!dialog || dialog.classList.contains('is-fullscreen')) return;
        event.preventDefault();
        event.stopPropagation();

        const startRect = dialog.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const minWidth = 720;
        const minHeight = 520;

        const onMove = (moveEvent) => {
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            let left = startRect.left;
            let top = startRect.top;
            let width = startRect.width;
            let height = startRect.height;

            if (direction.includes('e')) width = startRect.width + dx;
            if (direction.includes('s')) height = startRect.height + dy;
            if (direction.includes('w')) {
                width = startRect.width - dx;
                left = startRect.left + dx;
            }
            if (direction.includes('n')) {
                height = startRect.height - dy;
                top = startRect.top + dy;
            }

            width = Math.max(minWidth, width);
            height = Math.max(minHeight, height);
            if (direction.includes('w') && width === minWidth) left = startRect.right - minWidth;
            if (direction.includes('n') && height === minHeight) top = startRect.bottom - minHeight;

            dialog.style.left = `${left}px`;
            dialog.style.top = `${top}px`;
            dialog.style.width = `${width}px`;
            dialog.style.height = `${height}px`;
            dialog.dataset.webmeetSettingsUserSized = 'true';
        };

        const onUp = () => {
            window.removeEventListener('pointermove', onMove, true);
            window.removeEventListener('pointerup', onUp, true);
        };
        window.addEventListener('pointermove', onMove, true);
        window.addEventListener('pointerup', onUp, true);
    }

    ensureResizable() {
        const dialog = this.getDialogElement();
        if (!dialog || dialog.dataset.webmeetSettingsResizable === 'true') return;
        for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
            const handle = document.createElement('div');
            handle.className = `webmeet-settings-resize-handle ${direction}`;
            handle.addEventListener('pointerdown', (event) => this.startResize(event, direction));
            this.element.querySelector('.webmeet-settings-modal')?.appendChild(handle);
        }
        dialog.dataset.webmeetSettingsResizable = 'true';
    }

    toggleFullscreen() {
        const dialog = this.ensureDialogPositioning();
        if (!dialog) return;
        const shouldEnter = !dialog.classList.contains('is-fullscreen');
        if (shouldEnter) {
            const rect = dialog.getBoundingClientRect();
            this.dialogState.previous = {
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                userSized: dialog.dataset.webmeetSettingsUserSized === 'true'
            };
            dialog.classList.add('is-fullscreen');
            this.dialogState.isFullscreen = true;
            return;
        }
        dialog.classList.remove('is-fullscreen');
        const previous = this.dialogState.previous;
        if (previous) {
            dialog.style.left = `${previous.left}px`;
            dialog.style.top = `${previous.top}px`;
            if (previous.userSized) {
                dialog.style.width = `${previous.width}px`;
                dialog.style.height = `${previous.height}px`;
            } else {
                dialog.style.removeProperty('width');
                dialog.style.removeProperty('height');
            }
        }
        this.dialogState.isFullscreen = false;
    }

    dispatchAction(action, target = null) {
        window.dispatchEvent(new CustomEvent(SETTINGS_ACTION_EVENT, {
            detail: { action, target, modalElement: this.element }
        }));
    }

    closeMediaSettings(target) { this.dispatchAction('closeMediaSettings', target); }
    applyMediaSettings(target) { this.dispatchAction('applyMediaSettings', target); }
    setSettingsTab(target) { this.dispatchAction('setSettingsTab', target); }
    refreshMediaDevices(target) { this.dispatchAction('refreshMediaDevices', target); }
    resetWebMeetAvatarOverride(target) { this.dispatchAction('resetWebMeetAvatarOverride', target); }
    applyWebMeetAvatarSettings(target) { this.dispatchAction('applyWebMeetAvatarSettings', target); }
}
