import { TEXT_DEFAULT_STYLE, TEXT_FONT_FAMILIES, TEXT_MIN_FONT_SIZE, TEXT_MAX_FONT_SIZE } from '../webmeet-blackboard-panel/webmeet-blackboard-text-style.js';

const TEXT_WIDGET_TYPES = new Set(['text', 'card', 'input']);
const CHOICE_WIDGET_TYPES = new Set(['quiz', 'vote']);
const SURFACE_WIDGET_TYPES = new Set(['shape', 'card', 'text', 'quiz', 'vote', 'input', 'embed', 'image']);
const TEXT_COLOR_WIDGET_TYPES = new Set(['text', 'card', 'quiz', 'vote', 'input', 'embed']);

function readJsonAttribute(element, attributeName) {
    const raw = String(element?.getAttribute(attributeName) || '').trim();
    if (!raw) return null;
    try {
        return JSON.parse(decodeURIComponent(raw));
    } catch (_) {
        return null;
    }
}

function readWidgetFromElement(element) {
    return readJsonAttribute(element, 'data-widget-json');
}

function readThemeFromElement(element) {
    return readJsonAttribute(element, 'data-theme-json') || {};
}

function clampStrokeWidth(value, fallback = 1) {
    const strokeWidth = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(strokeWidth)) return fallback;
    return Math.max(0, Math.min(24, strokeWidth));
}

function clampFontSize(value, fallback = TEXT_DEFAULT_STYLE.fontSize) {
    const fontSize = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(fontSize)) return fallback;
    return Math.max(TEXT_MIN_FONT_SIZE, Math.min(TEXT_MAX_FONT_SIZE, fontSize));
}

function isHexColor(value) {
    return /^#[0-9a-f]{6}$/i.test(String(value || '').trim());
}

function sameColor(left, right) {
    return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase();
}

export class WebMeetBlackboardWidgetEditor {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.widget = readWidgetFromElement(element);
        this.theme = readThemeFromElement(element);
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
        this.typographySection = this.element.querySelector('[data-role="typographySection"]');
        this.fontFamilyInput = this.element.querySelector('[data-role="fontFamily"]');
        this.fontSizeInput = this.element.querySelector('[data-role="fontSize"]');
        this.textStyleColorInput = this.element.querySelector('[data-role="textStyleColor"]');
        this.fontBoldInput = this.element.querySelector('[data-role="fontBold"]');
        this.fontItalicInput = this.element.querySelector('[data-role="fontItalic"]');
        this.choiceSection = this.element.querySelector('[data-role="choiceSection"]');
        this.optionsInput = this.element.querySelector('[data-role="options"]');
        this.resultsVisibilityInput = this.element.querySelector('[data-role="resultsVisibility"]');
        this.lineSection = this.element.querySelector('[data-role="lineSection"]');
        this.lineMarkerInput = this.element.querySelector('[data-role="lineMarker"]');
        this.surfaceSection = this.element.querySelector('[data-role="surfaceSection"]');
        this.fillField = this.element.querySelector('[data-role="fillField"]');
        this.fillInput = this.element.querySelector('[data-role="fill"]');
        this.fillTransparentInput = this.element.querySelector('[data-role="fillTransparent"]');
        this.strokeLabel = this.element.querySelector('[data-role="strokeLabel"]');
        this.strokeInput = this.element.querySelector('[data-role="stroke"]');
        this.strokeWidthLabel = this.element.querySelector('[data-role="strokeWidthLabel"]');
        this.strokeWidthInput = this.element.querySelector('[data-role="strokeWidth"]');
        this.textColorField = this.element.querySelector('[data-role="textColorField"]');
        this.textColorInput = this.element.querySelector('[data-role="textColor"]');
        this.saveButton = this.element.querySelector('[type="submit"]');
    }

    bindEvents() {
        this.fillTransparentInput?.addEventListener('change', () => this.syncFillControlState());
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

    syncFillControlState() {
        if (!this.fillInput || !this.fillTransparentInput) return;
        this.fillInput.disabled = Boolean(this.fillTransparentInput.checked);
    }

    closeModal() {
        globalThis.assistOS?.UI?.closeModal?.(this.element, this.result);
    }

    getTypeDefaults(type) {
        const defaults = this.theme?.defaults || {};
        return defaults[type] || defaults.shape || {};
    }

    setThemedStyleValue(style, property, value, defaultValue) {
        const normalizedValue = String(value || '').trim();
        const normalizedDefault = String(defaultValue || '').trim();
        if (!normalizedValue) {
            delete style[property];
            return;
        }
        if (property === 'strokeWidth') {
            const numericValue = clampStrokeWidth(normalizedValue, Number(defaultValue ?? 1) || 1);
            const numericDefault = Number(defaultValue);
            if (Number.isFinite(numericDefault) && numericValue === numericDefault) {
                delete style[property];
            } else {
                style[property] = numericValue;
            }
            return;
        }
        if (normalizedDefault && sameColor(normalizedValue, normalizedDefault)) {
            delete style[property];
        } else {
            style[property] = normalizedValue;
        }
    }

    populateForm(widget = null) {
        if (!widget?.id) {
            if (this.title) this.title.textContent = 'Widget settings';
            if (this.subtitle) this.subtitle.textContent = 'Widget unavailable';
            if (this.textSection) this.textSection.hidden = true;
            if (this.typographySection) this.typographySection.hidden = true;
            if (this.choiceSection) this.choiceSection.hidden = true;
            if (this.lineSection) this.lineSection.hidden = true;
            if (this.surfaceSection) this.surfaceSection.hidden = true;
            if (this.saveButton) this.saveButton.disabled = true;
            return;
        }
        if (this.saveButton) this.saveButton.disabled = false;
        const type = String(widget?.type || 'widget').trim() || 'widget';
        const props = widget?.properties || {};
        const style = props.style || {};
        const typeDefaults = this.getTypeDefaults(type);
        const isChoice = CHOICE_WIDGET_TYPES.has(type);
        const isLine = type === 'line';
        const isSurface = SURFACE_WIDGET_TYPES.has(type) || isLine;
        const hasText = TEXT_WIDGET_TYPES.has(type) || isChoice;
        const hasTypography = type === 'text';
        const hasTextColor = TEXT_COLOR_WIDGET_TYPES.has(type) && !hasTypography;

        if (this.title) this.title.textContent = 'Widget settings';
        if (this.subtitle) this.subtitle.textContent = type;

        if (this.textSection) this.textSection.hidden = !hasText;
        if (this.textInput) this.textInput.value = this.getWidgetText(widget);
        if (this.textLabel) this.textLabel.textContent = isChoice ? 'Question' : 'Text';
        if (this.typographySection) this.typographySection.hidden = !hasTypography;
        if (hasTypography) {
            const fontFamily = TEXT_FONT_FAMILIES.includes(String(style.fontFamily || '').trim())
                ? String(style.fontFamily || '').trim()
                : TEXT_DEFAULT_STYLE.fontFamily;
            if (this.fontFamilyInput) this.fontFamilyInput.value = fontFamily;
            if (this.fontSizeInput) this.fontSizeInput.value = String(clampFontSize(style.fontSize));
            if (this.textStyleColorInput) {
                this.textStyleColorInput.value = isHexColor(style.textColor)
                    ? String(style.textColor).toLowerCase()
                    : (typeDefaults.textColor || TEXT_DEFAULT_STYLE.textColor);
            }
            if (this.fontBoldInput) this.fontBoldInput.checked = String(style.fontWeight || '').trim() === 'bold' || String(style.fontWeight || '') === '700';
            if (this.fontItalicInput) this.fontItalicInput.checked = String(style.fontStyle || '').trim() === 'italic';
        }

        if (this.choiceSection) this.choiceSection.hidden = !isChoice;
        if (this.optionsInput) this.optionsInput.value = Array.isArray(props.options) ? props.options.join(', ') : '';
        if (this.resultsVisibilityInput) {
            this.resultsVisibilityInput.value = props.resultsVisibility || props.aggregation?.resultsVisibility || 'moderatorsOnly';
        }

        if (this.lineSection) this.lineSection.hidden = !isLine;
        if (this.lineMarkerInput) this.lineMarkerInput.value = this.getLineMarkerValue(props.line || {});

        if (this.surfaceSection) this.surfaceSection.hidden = !isSurface;
        if (this.fillField) this.fillField.hidden = isLine;
        const isTransparentFill = String(style.fill || typeDefaults.fill || '').trim() === 'transparent';
        if (this.fillInput) this.fillInput.value = isTransparentFill ? '#ffffff' : (style.fill || typeDefaults.fill || '#ffffff');
        if (this.fillTransparentInput) this.fillTransparentInput.checked = isTransparentFill;
        this.syncFillControlState();
        if (this.strokeLabel) this.strokeLabel.textContent = isLine ? 'Line color' : 'Border';
        if (this.strokeWidthLabel) this.strokeWidthLabel.textContent = isLine ? 'Line width' : 'Border width';
        if (this.strokeInput) this.strokeInput.value = style.stroke || typeDefaults.stroke || '#334155';
        if (this.strokeWidthInput) this.strokeWidthInput.value = String(Number(style.strokeWidth ?? typeDefaults.strokeWidth ?? (isLine ? 3 : 2)) || 0);
        if (this.textColorField) this.textColorField.hidden = !hasTextColor;
        if (this.textColorInput) this.textColorInput.value = style.textColor || typeDefaults.textColor || TEXT_DEFAULT_STYLE.textColor;
    }

    getWidgetText(widget = {}) {
        const props = widget?.properties || {};
        if (widget?.type === 'quiz' || widget?.type === 'vote') return props.prompt || props.question || '';
        if (widget?.type === 'input') return props.label || '';
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
            const typeDefaults = this.getTypeDefaults(type);
            if (type !== 'line') {
                if (this.fillTransparentInput?.checked) {
                    style.fill = 'transparent';
                } else {
                    this.setThemedStyleValue(style, 'fill', this.fillInput?.value, typeDefaults.fill);
                }
            }
            this.setThemedStyleValue(style, 'stroke', this.strokeInput?.value, typeDefaults.stroke);
            this.setThemedStyleValue(style, 'strokeWidth', this.strokeWidthInput?.value, typeDefaults.strokeWidth ?? (type === 'line' ? 3 : 2));
            if (TEXT_COLOR_WIDGET_TYPES.has(type)) {
                const textColor = type === 'text' ? this.textStyleColorInput?.value : this.textColorInput?.value;
                this.setThemedStyleValue(style, 'textColor', textColor, typeDefaults.textColor);
            }
            if (type === 'text') {
                const fontFamily = String(this.fontFamilyInput?.value || '').trim();
                style.fontFamily = TEXT_FONT_FAMILIES.includes(fontFamily) ? fontFamily : TEXT_DEFAULT_STYLE.fontFamily;
                style.fontSize = clampFontSize(this.fontSizeInput?.value);
                style.fontWeight = this.fontBoldInput?.checked ? '700' : '400';
                style.fontStyle = this.fontItalicInput?.checked ? 'italic' : 'normal';
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
