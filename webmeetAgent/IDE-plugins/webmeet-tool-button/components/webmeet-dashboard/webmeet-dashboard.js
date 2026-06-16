export class WebMeetDashboard {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.invalidate();
    }

    async beforeRender() {
        const ensureComponentRegistered = window.assistOS?.webSkel?.ensureComponentRegistered || window.UI?.ensureComponentRegistered;
        if (typeof ensureComponentRegistered !== 'function') {
            return;
        }
        await Promise.all([
            ensureComponentRegistered('webmeet-dashbaoard'),
            ensureComponentRegistered('webmeet-participant-card'),
            ensureComponentRegistered('webmeet-blackboard-toolbar'),
            ensureComponentRegistered('webmeet-blackboard-widget-editor'),
            ensureComponentRegistered('webmeet-blackboard-results-panel'),
            ensureComponentRegistered('webmeet-blackboard-panel'),
            ensureComponentRegistered('webmeet-settings-modal'),
            ensureComponentRegistered('webmeet-room-settings-modal'),
            ensureComponentRegistered('webmeet-participant-audio-modal'),
            ensureComponentRegistered('create-room-modal')
        ]);
    }

    afterRender() {
        document.title = 'WebMeet';
    }
}
