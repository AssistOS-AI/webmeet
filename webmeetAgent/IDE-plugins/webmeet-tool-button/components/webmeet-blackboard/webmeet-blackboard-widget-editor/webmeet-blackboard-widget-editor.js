const TEXT_WIDGET_TYPES = new Set(['text', 'card', 'input']);
const CHOICE_WIDGET_TYPES = new Set(['quiz', 'vote']);
const SURFACE_WIDGET_TYPES = new Set(['shape', 'card', 'text', 'quiz', 'vote', 'input', 'embed']);
const TEXT_COLOR_WIDGET_TYPES = new Set(['text', 'card', 'quiz', 'vote', 'input', 'embed']);

function readWidgetFromElement(element) {
    const raw = String(
        element?.getAttribute('data-widget-json')
        || element?.getAttribute('data-widgetJson')
        || ''
    ).trim();
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function clampStrokeWidth(value, fallback = 1) {
    const strokeWidth = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(strokeWidth)) return fallback;
    return Math.max(0, Math.min(24, strokeWidth));
}

export class WebMeetBlackboardWidgetEditor {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.widget = readWidgetFromElement(element);
        this.result = null;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.bindEvents();
        this.populateForm(this.widget);
    }

    cacheElements() {
        this.form = this.element.querySelector('[data-role="form"]');
        this.title = this.element.querySelector('[data-role="title"]');
        this.subtitle = this.element.querySelector('[data-role="subtitle"]');
        this.textSection = this.element.querySelector('[data-role="textSection"]');
        this.textLabel = this.element.querySelector('[data-role="textLabel"]');
        this.textInput = this.element.querySelector('[data-role="text"]');
        this.choiceSection = this.element.querySelector('[data-role="choiceSection"]');
        this.optionsInput = this.element.querySelector('[data-role="options"]');
        this.resultsVisibilityInput = this.element.querySelector('[data-role="resultsVisibility"]');
        this.lineSection = this.element.querySelector('[data-role="lineSection"]');
        this.lineMarkerInput = this.element.querySelector('[data-role="lineMarker"]');
        this.surfaceSection = this.element.querySelector('[data-role="surfaceSection"]');
        this.fillField = this.element.querySelector('[data-role="fillField"]');
        this.fillInput = this.element.querySelector('[data-role="fill"]');
        this.strokeLabel = this.element.querySelector('[data-role="strokeLabel"]');
        this.strokeInput = this.element.querySelector('[data-role="stroke"]');
        this.strokeWidthLabel = this.element.querySelector('[data-role="strokeWidthLabel"]');
        this.strokeWidthInput = this.element.querySelector('[data-role="strokeWidth"]');
        this.textColorField = this.element.querySelector('[data-role="textColorField"]');
        this.textColorInput = this.element.querySelector('[data-role="textColor"]');
    }

    bindEvents() {
        this.form?.addEventListener('submit', (event) => {
            event.preventDefault();
            if (!this.widget?.id) return;
            this.result = {
                widgetId: this.widget.id,
                patch: this.buildPatchFromForm(this.widget)
            };
            this.closeModal();
        });
    }

    closeModal() {
        globalThis.assistOS?.UI?.closeModal?.(this.element, this.result);
    }

    populateForm(widget = {}) {
        const type = String(widget?.type || 'widget').trim() || 'widget';
        const props = widget?.properties || {};
        const style = props.style || {};
        const isChoice = CHOICE_WIDGET_TYPES.has(type);
        const isLine = type === 'line';
        const isSurface = SURFACE_WIDGET_TYPES.has(type) || isLine;
        const hasText = TEXT_WIDGET_TYPES.has(type) || isChoice;
        const hasTextColor = TEXT_COLOR_WIDGET_TYPES.has(type);

        if (this.title) this.title.textContent = 'Widget settings';
        if (this.subtitle) this.subtitle.textContent = type;

        if (this.textSection) this.textSection.hidden = !hasText;
        if (this.textInput) this.textInput.value = this.getWidgetText(widget);
        if (this.textLabel) this.textLabel.textContent = isChoice ? 'Question' : 'Text';

        if (this.choiceSection) this.choiceSection.hidden = !isChoice;
        if (this.optionsInput) this.optionsInput.value = Array.isArray(props.options) ? props.options.join(', ') : '';
        if (this.resultsVisibilityInput) {
            this.resultsVisibilityInput.value = props.resultsVisibility || props.aggregation?.resultsVisibility || 'moderatorsOnly';
        }

        if (this.lineSection) this.lineSection.hidden = !isLine;
        if (this.lineMarkerInput) this.lineMarkerInput.value = this.getLineMarkerValue(props.line || {});

        if (this.surfaceSection) this.surfaceSection.hidden = !isSurface;
        if (this.fillField) this.fillField.hidden = isLine;
        if (this.fillInput) this.fillInput.value = style.fill || '#ffffff';
        if (this.strokeLabel) this.strokeLabel.textContent = isLine ? 'Line color' : 'Border';
        if (this.strokeWidthLabel) this.strokeWidthLabel.textContent = isLine ? 'Line width' : 'Border width';
        if (this.strokeInput) this.strokeInput.value = style.stroke || '#334155';
        if (this.strokeWidthInput) this.strokeWidthInput.value = String(Number(style.strokeWidth ?? (isLine ? 3 : 2)) || 0);
        if (this.textColorField) this.textColorField.hidden = !hasTextColor;
        if (this.textColorInput) this.textColorInput.value = style.textColor || '#172033';
    }

    getWidgetText(widget = {}) {
        const props = widget.properties || {};
        if (widget.type === 'quiz' || widget.type === 'vote') return props.prompt || props.question || '';
        if (widget.type === 'input') return props.label || '';
        return props.text || props.label || '';
    }

    getLineMarkerValue(line = {}) {
        const markerStart = String(line.markerStart || '').trim();
        const markerEnd = String(line.markerEnd || '').trim();
        if (markerStart === 'arrow' && markerEnd === 'arrow') return 'both';
        if (markerStart === 'arrow') return 'start';
        if (markerEnd === 'arrow') return 'end';
        return 'none';
    }

    buildPatchFromForm(widget) {
        const type = String(widget?.type || '').trim();
        const patch = { properties: {} };
        const text = String(this.textInput?.value || '').trim();

        if (type === 'quiz') {
            patch.properties.prompt = text;
        } else if (type === 'vote') {
            patch.properties.prompt = text;
            patch.properties.question = text;
        } else if (type === 'input') {
            patch.properties.label = text;
        } else if (type === 'text' || type === 'card') {
            patch.properties.text = text;
        }

        if (CHOICE_WIDGET_TYPES.has(type)) {
            patch.properties.options = String(this.optionsInput?.value || '')
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            patch.properties.resultsVisibility = String(this.resultsVisibilityInput?.value || 'moderatorsOnly').trim();
        }

        if (SURFACE_WIDGET_TYPES.has(type) || type === 'line') {
            const style = { ...(widget.properties?.style || {}) };
            if (type !== 'line') {
                style.fill = String(this.fillInput?.value || style.fill || '#ffffff');
            }
            style.stroke = String(this.strokeInput?.value || style.stroke || '#334155');
            style.strokeWidth = clampStrokeWidth(this.strokeWidthInput?.value, style.strokeWidth ?? (type === 'line' ? 3 : 2));
            if (TEXT_COLOR_WIDGET_TYPES.has(type)) {
                style.textColor = String(this.textColorInput?.value || style.textColor || '#172033');
            }
            patch.properties.style = style;
        }

        if (type === 'line') {
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
