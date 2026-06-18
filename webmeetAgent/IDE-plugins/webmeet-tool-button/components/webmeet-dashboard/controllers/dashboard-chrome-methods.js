export const dashboardChromeMethods = {
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
        if (this.state.chatSidebarVisible && this.state.activeMobilePanel !== 'chat') {
            this.state.activeMobilePanel = 'chat';
            this.applyMobilePanelState();
        }
        this.applyChatSidebarVisibility();
    },

    setMobilePanel(panelName) {
        const nextPanel = ['room', 'rooms', 'chat', 'info', 'settings'].includes(panelName) ? panelName : 'room';
        if (nextPanel === 'settings') {
            this.toggleMediaSettings?.();
            return;
        }
        this.state.activeMobilePanel = nextPanel;
        this.applyMobilePanelState();
    },

    applyMobilePanelState() {
        const activePanel = String(this.state.activeMobilePanel || 'room').trim() || 'room';
        if (this.dashboardRoot) {
            this.dashboardRoot.dataset.mobilePanel = activePanel;
        }
        if (Array.isArray(this.mobileNavButtons)) {
            this.mobileNavButtons.forEach((button) => {
                const isActive = button.dataset.mobilePanel === activePanel;
                button.classList.toggle('is-active', isActive);
                if (isActive) {
                    button.setAttribute('aria-current', 'page');
                } else {
                    button.removeAttribute('aria-current');
                }
            });
        }
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
        if (this.dashboardRoot) {
            this.dashboardRoot.classList.toggle('webmeet-video-grid-fullscreen-mode', isActive);
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
