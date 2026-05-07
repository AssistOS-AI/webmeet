export class ParticipantLayoutController {
    constructor(options = {}) {
        this.getParticipantDisplayName = typeof options.getParticipantDisplayName === 'function'
            ? options.getParticipantDisplayName
            : ((participant) => String(participant?.identity || 'Participant'));

        this.videoGrid = null;
        this.videoGridAll = null;
        this.videoGridEmpty = null;
        this.trackElements = new Map();
        this.participantViews = new Map();
        this.focusedParticipantId = '';
    }

    setElements(elements = {}) {
        this.videoGrid = elements.videoGrid || null;
        this.videoGridAll = elements.videoGridAll || null;
        this.videoGridEmpty = elements.videoGridEmpty || null;
    }

    setVideoGridEmptyState(message) {
        if (this.videoGridEmpty) {
            this.videoGridEmpty.textContent = String(message || 'Join a meeting to attach media tracks.');
        }
    }

    buildInitials(name) {
        const text = String(name || '').trim();
        if (!text) return '?';
        const chunks = text.split(/\s+/).filter(Boolean);
        return chunks.slice(0, 2).map((part) => part[0]?.toUpperCase() || '').join('') || '?';
    }

    ensureNativeParticipantMarkup(element) {
        if (!element || element.querySelector('[data-role="mediaHost"]')) return;
        element.innerHTML = `
            <div class="wm-participant-shell">
                <div class="wm-participant-stage">
                    <div class="wm-participant-media" data-role="mediaHost"></div>
                    <div class="wm-participant-fallback" data-role="fallback">
                        <div class="wm-participant-avatar" data-role="avatar">?</div>
                    </div>
                    <div class="wm-participant-loading" data-role="videoLoading" aria-hidden="true">
                        <span class="wm-participant-spinner"></span>
                    </div>
                </div>
                <div class="wm-participant-footer" data-role="footer">
                    <span class="wm-participant-name" data-role="name">Participant</span>
                    <span class="wm-participant-mic is-off" data-role="mic" title="Microphone off" aria-label="Microphone off">
                        <svg class="wm-mic-on" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                        </svg>
                        <svg class="wm-mic-off" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="1" y1="1" x2="23" y2="23"></line>
                            <path d="M9 9v6a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.18"></path>
                            <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                        </svg>
                    </span>
                </div>
            </div>
        `;
    }

    applyNativeParticipantState(view, payload) {
        this.ensureNativeParticipantMarkup(view.element);
        view.element.classList.toggle('is-mini', Boolean(payload.isMini));
        view.element.classList.toggle('is-focused', Boolean(payload.isFocused));
        view.element.dataset.local = payload.isLocal ? 'true' : 'false';

        const name = view.element.querySelector('[data-role="name"]');
        const avatar = view.element.querySelector('[data-role="avatar"]');
        const fallback = view.element.querySelector('[data-role="fallback"]');
        const videoLoading = view.element.querySelector('[data-role="videoLoading"]');
        const mic = view.element.querySelector('[data-role="mic"]');
        if (name) name.textContent = payload.displayName;
        if (avatar) avatar.textContent = this.buildInitials(payload.displayName);
        if (fallback) fallback.style.display = payload.hasVideo ? 'none' : 'flex';
        view.element.classList.toggle('is-video-loading', Boolean(payload.videoLoading));
        if (videoLoading) videoLoading.style.display = payload.videoLoading ? 'flex' : 'none';
        if (mic) {
            mic.classList.toggle('is-on', Boolean(payload.isMicOn));
            mic.classList.toggle('is-off', !payload.isMicOn);
            const micLabel = payload.isMicOn ? 'Microphone on' : 'Microphone off';
            mic.title = micLabel;
            mic.setAttribute('aria-label', micLabel);
        }
    }

    syncVideoGridVisibility() {
        const participantCount = this.participantViews.size;
        const hasParticipants = participantCount > 0;
        const hasFocusedParticipant = Boolean(this.focusedParticipantId && this.participantViews.has(this.focusedParticipantId));
        if (this.videoGridEmpty) {
            this.videoGridEmpty.classList.toggle('webmeet-hidden', hasParticipants);
        }
        if (this.videoGridAll) {
            this.videoGridAll.classList.toggle('webmeet-hidden', !hasParticipants);
            this.videoGridAll.classList.toggle('has-focus', hasFocusedParticipant);
        }
    }

    applyParticipantViewState(view) {
        if (!view || !view.element) return;
        const payload = {
            participantId: view.id,
            displayName: view.name,
            isLocal: Boolean(view.isLocal),
            isMicOn: Boolean(view.micOn),
            hasVideo: Boolean(view.hasVideo),
            videoLoading: Boolean(view.videoLoading),
            isMini: Boolean(view.isMini),
            isFocused: Boolean(view.isFocused)
        };
        view.element.dataset.participantId = payload.participantId;
        view.element.setAttribute('data-display-name', payload.displayName);
        view.element.setAttribute('data-is-local', payload.isLocal ? 'true' : 'false');
        view.element.setAttribute('data-is-mic-on', payload.isMicOn ? 'true' : 'false');
        view.element.setAttribute('data-has-video', payload.hasVideo ? 'true' : 'false');
        view.element.setAttribute('data-video-loading', payload.videoLoading ? 'true' : 'false');
        view.element.setAttribute('data-is-mini', payload.isMini ? 'true' : 'false');
        view.element.setAttribute('data-is-focused', payload.isFocused ? 'true' : 'false');
        const presenter = view.element.webSkelPresenter;
        if (presenter && typeof presenter.setState === 'function') {
            presenter.setState(payload);
        } else {
            this.applyNativeParticipantState(view, payload);
        }
        if (view.videoElement) {
            if (presenter && typeof presenter.setVideoElement === 'function') {
                presenter.setVideoElement(view.videoElement);
            } else {
                const mediaHost = view.element.querySelector('[data-role="mediaHost"]');
                if (mediaHost && !mediaHost.contains(view.videoElement)) {
                    mediaHost.appendChild(view.videoElement);
                }
            }
        }
    }

    upsertParticipantView(participant) {
        const id = String(participant?.identity || '').trim();
        if (!id || !this.videoGrid) return null;
        let view = this.participantViews.get(id);
        if (!view) {
            const element = document.createElement('webmeet-participant-card');
            element.setAttribute('data-presenter', 'webmeet-participant-card');
            element.setAttribute('data-local-action', 'focusParticipantCard');
            element.dataset.participantId = id;
            element.title = 'Focus participant';
            view = {
                id,
                name: this.getParticipantDisplayName(participant),
                isLocal: Boolean(participant.kind === 'local'),
                hasVideo: false,
                videoLoading: false,
                micOn: false,
                isMini: true,
                isFocused: false,
                element
            };
            this.participantViews.set(id, view);
        } else {
            view.name = this.getParticipantDisplayName(participant);
            view.isLocal = Boolean(participant.kind === 'local');
        }
        this.applyParticipantViewState(view);
        return view;
    }

    renderParticipantLayout() {
        if (!this.videoGrid || !this.videoGridAll) return;
        if (!this.participantViews.size) {
            this.focusedParticipantId = '';
            this.syncVideoGridVisibility();
            return;
        }
        const hasFocusedParticipant = Boolean(this.focusedParticipantId && this.participantViews.has(this.focusedParticipantId));
        if (!hasFocusedParticipant) {
            this.focusedParticipantId = '';
            for (const view of this.participantViews.values()) {
                view.isFocused = false;
                view.isMini = false;
                if (view.element.parentElement !== this.videoGridAll) {
                    this.videoGridAll.appendChild(view.element);
                }
                this.applyParticipantViewState(view);
            }
            this.syncVideoGridVisibility();
            return;
        }

        for (const view of this.participantViews.values()) {
            const isFocused = view.id === this.focusedParticipantId;
            view.isFocused = isFocused;
            view.isMini = !isFocused;
            if (view.element.parentElement !== this.videoGridAll) {
                this.videoGridAll.appendChild(view.element);
            }
            this.applyParticipantViewState(view);
        }
        this.syncVideoGridVisibility();
    }

    setFocusedParticipant(participantId) {
        const id = String(participantId || '').trim();
        if (!id || !this.participantViews.has(id)) return;
        this.focusedParticipantId = id;
        this.renderParticipantLayout();
    }

    focusParticipantCard(target) {
        const participantId = String(target?.dataset?.participantId || '').trim();
        if (!participantId) return;
        if (this.focusedParticipantId === participantId) {
            this.focusedParticipantId = '';
            this.renderParticipantLayout();
            return;
        }
        this.setFocusedParticipant(participantId);
    }

    setParticipantMicState(participantId, isMicOn) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        view.micOn = Boolean(isMicOn);
        this.applyParticipantViewState(view);
    }

    setParticipantVideoLoading(participantId, isLoading) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        view.videoLoading = Boolean(isLoading);
        this.applyParticipantViewState(view);
    }

    attachVideoTrack(participantId, trackSid, mediaElement) {
        const id = String(participantId || '').trim();
        if (!id || !trackSid || !mediaElement) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        view.videoElement = mediaElement;
        if (view.element.parentElement !== this.videoGridAll && this.videoGridAll) {
            this.videoGridAll.appendChild(view.element);
        }

        const tryAttach = () => {
            const presenter = view.element.webSkelPresenter;
            if (presenter && typeof presenter.setVideoElement === 'function') {
                presenter.setVideoElement(mediaElement);
            } else {
                const host = view.element.querySelector('[data-role="mediaHost"]');
                if (host) {
                    // Remove existing video elements to prevent duplicates in Safari
                    const existingVideos = host.querySelectorAll('video');
                    existingVideos.forEach(video => {
                        if (video !== mediaElement && video.parentNode === host) {
                            video.remove();
                        }
                    });
                    
                    if (!host.contains(mediaElement)) {
                        host.appendChild(mediaElement);
                    }
                }
            }
            const host = view.element.querySelector('[data-role="mediaHost"]');
            const attached = Boolean(host && host.contains(mediaElement));
            view.hasVideo = attached;
            if (attached) {
                view.videoLoading = false;
            }
            this.applyParticipantViewState(view);
            return attached;
        };

        if (!tryAttach()) {
            let attempts = 0;
            const retryAttach = () => {
                attempts += 1;
                if (tryAttach() || attempts >= 12) {
                    return;
                }
                requestAnimationFrame(retryAttach);
            };
            requestAnimationFrame(retryAttach);
        }

        this.trackElements.set(trackSid, {
            participantId: id,
            kind: 'video',
            element: mediaElement
        });
        this.renderParticipantLayout();
    }

    clearVideoTrack(trackSid) {
        const track = this.trackElements.get(trackSid);
        if (!track || track.kind !== 'video') return;
        const view = this.participantViews.get(track.participantId);
            if (view) {
                const presenter = view.element.webSkelPresenter;
                if (presenter && typeof presenter.clearVideoElement === 'function') {
                    presenter.clearVideoElement();
                } else {
                const host = view.element.querySelector('[data-role="mediaHost"]');
                const video = host?.querySelector('video');
                if (video) {
                    try { video.srcObject = null; } catch (_) {}
                    video.remove();
                }
            }
            view.hasVideo = false;
            view.videoLoading = false;
            view.videoElement = null;
            this.applyParticipantViewState(view);
        }
        try { track.element.srcObject = null; } catch (_) {}
        track.element.remove();
        this.trackElements.delete(trackSid);
    }

    attachAudioTrack(participantId, trackSid, mediaElement) {
        const id = String(participantId || '').trim();
        if (!id || !trackSid || !mediaElement) return;
        mediaElement.style.cssText = 'position:absolute;width:0;height:0;opacity:0;pointer-events:none;';
        const view = this.participantViews.get(id);
        if (view?.element && !view.element.contains(mediaElement)) {
            view.element.appendChild(mediaElement);
        }
        this.trackElements.set(trackSid, {
            participantId: id,
            kind: 'audio',
            element: mediaElement
        });
    }

    removeTrack(trackSid) {
        const entry = this.trackElements.get(trackSid);
        if (!entry) return;
        if (entry.kind === 'video') {
            this.clearVideoTrack(trackSid);
            return;
        }
        try { entry.element.srcObject = null; } catch (_) {}
        entry.element.remove();
        this.trackElements.delete(trackSid);
    }

    removeParticipantView(participantId) {
        const id = String(participantId || '').trim();
        if (!id) return;
        const view = this.participantViews.get(id);
        if (!view) return;
        for (const [trackSid, track] of this.trackElements.entries()) {
            if (track.participantId === id) {
                this.removeTrack(trackSid);
            }
        }
        view.element.remove();
        this.participantViews.delete(id);
        if (this.focusedParticipantId === id) {
            this.focusedParticipantId = this.participantViews.keys().next().value || '';
        }
        this.renderParticipantLayout();
    }

    getTrackEntry(trackSid) {
        return this.trackElements.get(trackSid);
    }

    getTrackEntries() {
        return Array.from(this.trackElements.values());
    }

    getParticipantView(participantId) {
        const id = String(participantId || '').trim();
        if (!id) return null;
        return this.participantViews.get(id) || null;
    }

    getParticipantIds() {
        return Array.from(this.participantViews.keys());
    }

    clearAll(message = 'Join a meeting to attach media tracks.') {
        for (const track of this.trackElements.values()) {
            try { track.element.srcObject = null; } catch (_) {}
            track.element.remove();
        }
        for (const view of this.participantViews.values()) {
            const presenter = view.element.webSkelPresenter;
            if (presenter && typeof presenter.clearVideoElement === 'function') {
                presenter.clearVideoElement();
            }
            view.element.remove();
        }
        this.trackElements.clear();
        this.participantViews.clear();
        this.focusedParticipantId = '';
        this.setVideoGridEmptyState(message);
        this.syncVideoGridVisibility();
    }
}
