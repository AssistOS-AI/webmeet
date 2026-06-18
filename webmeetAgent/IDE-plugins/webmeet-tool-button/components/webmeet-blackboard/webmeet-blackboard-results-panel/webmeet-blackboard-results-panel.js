export class WebMeetBlackboardResultsPanel {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.element.setWidget = (widget) => this.setWidget(widget);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {}

    setWidget(widget = null) {
        this.widget = widget;
        const target = this.element.querySelector('[data-role="results"]') || this.element;
        target.textContent = widget?.properties?.aggregation ? JSON.stringify(widget.properties.aggregation, null, 2) : '';
    }
}
