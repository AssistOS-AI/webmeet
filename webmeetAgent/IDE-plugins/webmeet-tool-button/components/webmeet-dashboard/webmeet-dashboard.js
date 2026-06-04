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
            ensureComponentRegistered('webmeet-participant-card')
        ]);
    }

    afterRender() {
        document.title = 'WebMeet';
    }
}
