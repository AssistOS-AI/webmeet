export class WebMeetBlackboardWidgetEditor {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.widget = null;
        this.element.open = (widget) => this.open(widget);
        this.element.close = () => this.close();
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.close();
    }

    cacheElements() {
        this.form = this.element.querySelector('[data-role="form"]');
        this.title = this.element.querySelector('[data-role="title"]');
        this.textInput = this.element.querySelector('[data-role="text"]');
        this.optionsField = this.element.querySelector('[data-role="optionsField"]');
        this.optionsInput = this.element.querySelector('[data-role="options"]');
        this.resultsVisibilityField = this.element.querySelector('[data-role="resultsVisibilityField"]');
        this.resultsVisibilityInput = this.element.querySelector('[data-role="resultsVisibility"]');
        this.shapeKindField = this.element.querySelector('[data-role="shapeKindField"]');
        this.shapeKindInput = this.element.querySelector('[data-role="shapeKind"]');
        this.lineMarkerField = this.element.querySelector('[data-role="lineMarkerField"]');
        this.lineMarkerInput = this.element.querySelector('[data-role="lineMarker"]');
        this.styleFields = this.element.querySelector('[data-role="styleFields"]');
        this.fillInput = this.element.querySelector('[data-role="fill"]');
        this.strokeInput = this.element.querySelector('[data-role="stroke"]');
        this.cancelButton = this.element.querySelector('[data-role="cancel"]');
    }

    bindEvents() {
        this.form?.addEventListener('pointerdown', (event) => event.stopPropagation());
        this.cancelButton?.addEventListener('click', () => this.close());
        this.form?.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!this.widget?.id) return;
            this.element.dispatchEvent(new CustomEvent('blackboard-editor-save', {
                bubbles: true,
                composed: true,
                detail: {
                    widgetId: this.widget.id,
                    patch: this.buildPatchFromForm(this.widget)
                }
            }));
            this.close();
        });
    }

    open(widget) {
        this.widget = widget;
        this.cacheElements();
        this.populateForm(widget);
        this.element.hidden = false;
        this.textInput?.focus();
    }

    close() {
        this.widget = null;
        this.element.hidden = true;
    }

    populateForm(widget = {}) {
        const props = widget.properties || {};
        const textValue = props.prompt || props.question || props.label || props.text || '';
        const hasOptions = widget.type === 'quiz' || widget.type === 'vote';
        const hasStyle = widget.type === 'shape' || widget.type === 'card' || widget.type === 'line';
        const hasShapeKind = widget.type === 'shape';
        const hasLineMarker = widget.type === 'line';

        if (this.title) this.title.textContent = `Edit ${String(widget.type || 'widget')}`;
        if (this.textInput) this.textInput.value = textValue;
        if (this.optionsInput) this.optionsInput.value = Array.isArray(props.options) ? props.options.join(', ') : '';
        if (this.resultsVisibilityInput) {
            this.resultsVisibilityInput.value = props.resultsVisibility || props.aggregation?.resultsVisibility || 'moderatorsOnly';
        }
        if (this.fillInput) this.fillInput.value = props.style?.fill || '#ffffff';
        if (this.strokeInput) this.strokeInput.value = props.style?.stroke || '#334155';
        if (this.shapeKindInput) this.shapeKindInput.value = props.shapeKind || 'rectangle';
        if (this.lineMarkerInput) {
            const markerStart = String(props.line?.markerStart || '').trim();
            const markerEnd = String(props.line?.markerEnd || '').trim();
            this.lineMarkerInput.value = markerStart === 'arrow' && markerEnd === 'arrow'
                ? 'both'
                : markerStart === 'arrow'
                ? 'start'
                : markerEnd === 'arrow'
                ? 'end'
                : 'none';
        }
        if (this.optionsField) this.optionsField.hidden = !hasOptions;
        if (this.resultsVisibilityField) this.resultsVisibilityField.hidden = !hasOptions;
        if (this.shapeKindField) this.shapeKindField.hidden = !hasShapeKind;
        if (this.lineMarkerField) this.lineMarkerField.hidden = !hasLineMarker;
        if (this.styleFields) this.styleFields.hidden = !hasStyle;
    }

    buildPatchFromForm(widget) {
        const text = String(this.textInput?.value || '').trim();
        const patch = { properties: {} };
        if (widget.type === 'quiz') {
            patch.properties.prompt = text;
        } else if (widget.type === 'vote') {
            patch.properties.prompt = text;
            patch.properties.question = text;
        } else if (widget.type === 'input') {
            patch.properties.label = text;
        } else if (widget.type === 'text') {
            patch.properties.text = text;
        } else {
            patch.properties.label = text;
        }
        if (widget.type === 'quiz' || widget.type === 'vote') {
            patch.properties.options = String(this.optionsInput?.value || '')
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            patch.properties.resultsVisibility = String(this.resultsVisibilityInput?.value || 'moderatorsOnly').trim();
        }
        if (widget.type === 'shape' || widget.type === 'card' || widget.type === 'line') {
            patch.properties.style = {
                ...(widget.properties?.style || {}),
                fill: String(this.fillInput?.value || widget.properties?.style?.fill || '#ffffff'),
                stroke: String(this.strokeInput?.value || widget.properties?.style?.stroke || '#334155')
            };
        }
        if (widget.type === 'shape') {
            patch.properties.shapeKind = String(this.shapeKindInput?.value || widget.properties?.shapeKind || 'rectangle').trim() || 'rectangle';
        }
        if (widget.type === 'line') {
            const marker = String(this.lineMarkerInput?.value || 'none').trim();
            patch.properties.line = {
                ...(widget.properties?.line || {}),
                markerStart: marker === 'start' || marker === 'both' ? 'arrow' : '',
                markerEnd: marker === 'end' || marker === 'both' ? 'arrow' : ''
            };
        }
        return patch;
    }
}
