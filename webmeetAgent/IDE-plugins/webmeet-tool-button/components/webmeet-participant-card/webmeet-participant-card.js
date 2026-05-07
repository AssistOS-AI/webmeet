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
            isFocused: parseBoolean(element.getAttribute('data-is-focused'))
        };
        this.invalidate();
    }

    beforeRender() {
        this.displayName = this.state.displayName;
        this.initials = buildInitials(this.state.displayName);
    }

    afterRender() {
        this.refs = {
            mediaHost: this.element.querySelector('[data-role="mediaHost"]'),
            fallback: this.element.querySelector('[data-role="fallback"]'),
            avatar: this.element.querySelector('[data-role="avatar"]'),
            footer: this.element.querySelector('[data-role="footer"]'),
            name: this.element.querySelector('[data-role="name"]'),
            mic: this.element.querySelector('[data-role="mic"]'),
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
        this.element.dataset.participantId = String(this.state.participantId || '').trim();
        this.element.dataset.local = this.state.isLocal ? 'true' : 'false';
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
