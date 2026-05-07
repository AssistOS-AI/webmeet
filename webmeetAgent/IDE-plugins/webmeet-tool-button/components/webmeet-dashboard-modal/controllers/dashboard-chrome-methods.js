export const dashboardChromeMethods = {
    getDialogElement() {
        return this.element?.closest?.('dialog') || null;
    },

    syncFullscreenButtonState() {
        const dialog = this.getDialogElement();
        const isFullscreen = Boolean(dialog?.classList.contains('is-fullscreen'));
        if (!this.fullscreenButton) return;
        this.fullscreenButton.classList.toggle('active', isFullscreen);
        this.fullscreenButton.title = isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen';
        this.fullscreenButton.setAttribute('aria-label', isFullscreen ? 'Exit fullscreen' : 'Toggle fullscreen');
    },

    toggleFullscreen() {
        const dialog = this.getDialogElement();
        if (!dialog) return;
        dialog.classList.toggle('is-fullscreen');
        this.syncFullscreenButtonState();
    },

    applyChatSidebarVisibility() {
        const isVisible = this.state.chatSidebarVisible !== false;
        if (this.chatSidebar) {
            this.chatSidebar.classList.toggle('webmeet-hidden', !isVisible);
        }
        if (this.chatResizer) {
            this.chatResizer.classList.toggle('webmeet-hidden', !isVisible);
        }
        if (this.mainContent) {
            this.mainContent.classList.toggle('webmeet-chat-hidden', !isVisible);
        }
        if (this.toggleChatButton) {
            this.toggleChatButton.classList.toggle('active', isVisible);
            this.toggleChatButton.title = isVisible ? 'Hide chat' : 'Show chat';
            this.toggleChatButton.setAttribute('aria-label', isVisible ? 'Hide chat' : 'Show chat');
        }
    },

    toggleChatSidebar() {
        this.state.chatSidebarVisible = !this.state.chatSidebarVisible;
        this.applyChatSidebarVisibility();
    },

    loadChatSidebarWidth() {
        const fallback = 320;
        try {
            const raw = Number.parseInt(String(window?.localStorage?.getItem('webmeet.chatSidebarWidth') || '').trim(), 10);
            if (!Number.isFinite(raw)) return fallback;
            return Math.max(260, Math.min(1400, raw));
        } catch {
            return fallback;
        }
    },

    persistChatSidebarWidth() {
        try {
            window?.localStorage?.setItem('webmeet.chatSidebarWidth', String(this.chatSidebarWidth));
        } catch (_) {
            // ignore storage failures
        }
    },

    applyChatSidebarWidth() {
        if (!this.mainContent) return;
        this.mainContent.style.setProperty('--webmeet-chat-sidebar-width', `${this.chatSidebarWidth}px`);
    },

    registerChatSidebarResizer() {
        if (!this.chatResizer || !this.mainContent || this.chatResizer.dataset.bound === 'true') {
            return;
        }
        const startResize = (event) => {
            if (this.state.chatSidebarVisible === false) return;
            event.preventDefault();
            event.stopPropagation();

            const mainRect = this.mainContent.getBoundingClientRect();
            const minWidth = 260;
            const minLiveWidth = 252;
            const resizerWidth = 10;
            const maxWidth = Math.max(minWidth, Math.floor(mainRect.width - minLiveWidth - resizerWidth));

            const onMove = (moveEvent) => {
                const nextWidth = Math.round(mainRect.right - moveEvent.clientX);
                this.chatSidebarWidth = Math.max(minWidth, Math.min(maxWidth, nextWidth));
                this.mainContent.classList.add('webmeet-chat-resizing');
                this.applyChatSidebarWidth();
            };

            const onUp = () => {
                window.removeEventListener('pointermove', onMove, true);
                window.removeEventListener('pointerup', onUp, true);
                this.mainContent.classList.remove('webmeet-chat-resizing');
                this.persistChatSidebarWidth();
            };

            window.addEventListener('pointermove', onMove, true);
            window.addEventListener('pointerup', onUp, true);
        };

        this.chatResizer.addEventListener('pointerdown', startResize);
        this.chatResizer.dataset.bound = 'true';
    },

    applyVideoGridFullscreenMode() {
        const isActive = Boolean(this.state.videoGridFullscreen);
        if (this.dashboardModalRoot) {
            this.dashboardModalRoot.classList.toggle('webmeet-video-grid-fullscreen-mode', isActive);
        }
        if (this.videoGridFullscreenButton) {
            this.videoGridFullscreenButton.classList.toggle('active', isActive);
            const label = isActive ? 'Exit video fullscreen' : 'Video fullscreen';
            this.videoGridFullscreenButton.title = label;
            this.videoGridFullscreenButton.setAttribute('aria-label', label);
        }
    },

    toggleVideoGridFullscreen() {
        const isJoined = Boolean(this.state.session?.participantIdentity);
        if (!isJoined) {
            this.setError('Join a meeting before entering video fullscreen.');
            return;
        }
        this.state.videoGridFullscreen = !this.state.videoGridFullscreen;
        this.applyVideoGridFullscreenMode();
    }

};
