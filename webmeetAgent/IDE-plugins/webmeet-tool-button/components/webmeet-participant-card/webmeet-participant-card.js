function parseBoolean(value) {
    return String(value || '').toLowerCase() === 'true';
}

function buildInitials(name) {
    const text = String(name || '').trim();
    if (!text) return '?';
    const chunks = text.split(/\s+/).filter(Boolean);
    if (!chunks.length) return '?';
    return chunks.slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

export class WebMeetParticipantCard {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.refs = null;
        this.mediaElement = null;
        this.mediaElements = [];
        this.mediaAspectCleanup = null;
        this.state = {
            participantId: String(element.getAttribute('data-participant-id') || '').trim(),
            displayName: String(element.getAttribute('data-display-name') || 'Participant').trim() || 'Participant',
            isLocal: parseBoolean(element.getAttribute('data-is-local')),
            hasVideo: parseBoolean(element.getAttribute('data-has-video')),
            videoLoading: parseBoolean(element.getAttribute('data-video-loading')),
            isMicOn: parseBoolean(element.getAttribute('data-is-mic-on')),
            isMini: parseBoolean(element.getAttribute('data-is-mini')),
            isFocused: parseBoolean(element.getAttribute('data-is-focused')),
            isAgent: parseBoolean(element.getAttribute('data-is-agent')),
            agentId: String(element.getAttribute('data-agent-id') || '').trim(),
            canDetachAgent: parseBoolean(element.getAttribute('data-can-detach-agent')),
            canConfigureAudio: parseBoolean(element.getAttribute('data-can-configure-audio')),
            hasCustomAudioSettings: parseBoolean(element.getAttribute('data-has-custom-audio-settings')),
            isAudioMutedLocally: parseBoolean(element.getAttribute('data-is-audio-muted-locally'))
        };
        this.invalidate();
    }

    beforeRender() {
        this.displayName = this.state.displayName;
        this.initials = buildInitials(this.state.displayName);
        this.participantId = this.state.participantId;
        this.agentId = this.state.agentId;
    }

    afterRender() {
        this.refs = {
            mediaHost: this.element.querySelector('[data-role="mediaHost"]'),
            fallback: this.element.querySelector('[data-role="fallback"]'),
            avatar: this.element.querySelector('[data-role="avatar"]'),
            footer: this.element.querySelector('[data-role="footer"]'),
            name: this.element.querySelector('[data-role="name"]'),
            mic: this.element.querySelector('[data-role="mic"]'),
            audioSettings: this.element.querySelector('[data-role="audioSettings"]'),
            agentDetach: this.element.querySelector('[data-role="agentDetach"]'),
            videoLoading: this.element.querySelector('[data-role="videoLoading"]')
        };
        this.applyState();
        this.syncMediaElements();
    }

    setState(patch = {}) {
        this.state = {
            ...this.state,
            ...patch
        };
        this.applyState();
    }

    setVideoElement(mediaElement) {
        this.setVideoElements(mediaElement ? [mediaElement] : []);
    }

    setVideoElements(mediaElements = []) {
        const nextElements = Array.from(mediaElements).filter(Boolean);
        this.mediaAspectCleanup?.();
        this.mediaAspectCleanup = null;
        const previousElements = this.mediaElements.length ? this.mediaElements : (this.mediaElement ? [this.mediaElement] : []);
        for (const element of previousElements) {
            if (!nextElements.includes(element)) {
                try { element.srcObject = null; } catch (_) {}
                element.remove();
            }
        }
        this.mediaElements = nextElements;
        this.mediaElement = nextElements[0] || null;
        this.syncMediaElements();
        this.installMediaAspectObserver();
        this.setState({ hasVideo: nextElements.length > 0, videoLoading: false });
    }

    syncMediaElements() {
        const host = this.refs?.mediaHost || null;
        if (!host) return;
        const keep = new Set(this.mediaElements);
        for (const existing of host.querySelectorAll('video')) {
            if (!keep.has(existing)) {
                try { existing.srcObject = null; } catch (_) {}
                existing.remove();
            }
        }
        for (const mediaElement of this.mediaElements) {
            if (!host.contains(mediaElement)) {
                host.appendChild(mediaElement);
            }
        }
        host.classList.toggle('has-multiple-videos', this.mediaElements.length > 1);
        host.dataset.videoCount = String(this.mediaElements.length);
    }

    clearVideoElement() {
        if (!this.mediaElements.length && !this.mediaElement) {
            this.setState({ hasVideo: false });
            return;
        }
        for (const mediaElement of this.mediaElements.length ? this.mediaElements : [this.mediaElement]) {
            try { mediaElement.srcObject = null; } catch (_) {}
            mediaElement.remove();
        }
        this.mediaAspectCleanup?.();
        this.mediaAspectCleanup = null;
        this.mediaElements = [];
        this.mediaElement = null;
        this.element.style.removeProperty('--wm-media-aspect-ratio');
        this.syncMediaElements();
        this.setState({ hasVideo: false });
    }

    getMediaHost() {
        return this.refs?.mediaHost || null;
    }

    applyState() {
        if (!this.refs) return;
        const displayName = String(this.state.displayName || 'Participant').trim() || 'Participant';
        const initials = buildInitials(displayName);
        this.element.classList.toggle('is-mini', Boolean(this.state.isMini));
        this.element.classList.toggle('is-focused', Boolean(this.state.isFocused));
        this.element.classList.toggle('is-agent', Boolean(this.state.isAgent));
        this.element.dataset.participantId = String(this.state.participantId || '').trim();
        this.element.dataset.agentId = String(this.state.agentId || '').trim();
        this.element.dataset.local = this.state.isLocal ? 'true' : 'false';
        this.element.dataset.hasCustomAudioSettings = this.state.hasCustomAudioSettings ? 'true' : 'false';
        this.refs.name.textContent = displayName;
        this.refs.avatar.textContent = initials;
        this.refs.fallback.style.display = this.state.hasVideo ? 'none' : 'flex';
        this.element.classList.toggle('is-video-loading', Boolean(this.state.videoLoading));
        if (this.refs.videoLoading) {
            this.refs.videoLoading.style.display = this.state.videoLoading ? 'flex' : 'none';
        }

        this.refs.mic.classList.toggle('is-on', Boolean(this.state.isMicOn));
        this.refs.mic.classList.toggle('is-off', !this.state.isMicOn);
        const micLabel = this.state.isMicOn ? 'Microphone on' : 'Microphone off';
        this.refs.mic.title = micLabel;
        this.refs.mic.setAttribute('aria-label', micLabel);

        if (this.refs.audioSettings) {
            const participantId = String(this.state.participantId || '').trim();
            const showAudioSettings = Boolean(this.state.canConfigureAudio && participantId);
            const hasCustomAudioSettings = Boolean(this.state.hasCustomAudioSettings);
            const isMutedLocally = Boolean(this.state.isAudioMutedLocally);
            let audioLabel = 'Audio settings';
            if (isMutedLocally) {
                audioLabel = 'Audio settings (muted locally)';
            } else if (hasCustomAudioSettings) {
                audioLabel = 'Audio settings applied';
            }
            this.refs.audioSettings.style.display = showAudioSettings ? 'inline-flex' : 'none';
            this.refs.audioSettings.dataset.participantId = participantId;
            this.refs.audioSettings.classList.toggle('is-active', hasCustomAudioSettings);
            this.refs.audioSettings.classList.toggle('is-muted', isMutedLocally);
            this.refs.audioSettings.title = audioLabel;
            this.refs.audioSettings.setAttribute('aria-label', audioLabel);
        }

        if (this.refs.agentDetach) {
            const agentId = String(this.state.agentId || '').trim();
            const showDetach = Boolean(this.state.isAgent && this.state.canDetachAgent && agentId);
            this.refs.agentDetach.style.display = showDetach ? 'inline-flex' : 'none';
            this.refs.agentDetach.dataset.agentId = agentId;
        }
    }

    installMediaAspectObserver() {
        const video = this.mediaElement;
        if (!video) {
            this.element.style.removeProperty('--wm-media-aspect-ratio');
            return;
        }
        const sync = () => {
            const width = Number(video.videoWidth || 0);
            const height = Number(video.videoHeight || 0);
            if (width > 0 && height > 0) {
                this.element.style.setProperty('--wm-media-aspect-ratio', `${width} / ${height}`);
            }
        };
        sync();
        video.addEventListener('loadedmetadata', sync);
        video.addEventListener('resize', sync);
        this.mediaAspectCleanup = () => {
            video.removeEventListener('loadedmetadata', sync);
            video.removeEventListener('resize', sync);
        };
    }
}
