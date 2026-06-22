import { TEXT_DEFAULT_STYLE, TEXT_FONT_FAMILIES, TEXT_MIN_FONT_SIZE, TEXT_MAX_FONT_SIZE } from '../webmeet-blackboard-panel/webmeet-blackboard-text-style.js';

const TEXT_WIDGET_TYPES = new Set(['text', 'card']);
const CHOICE_WIDGET_TYPES = new Set(['poll']);
const SURFACE_WIDGET_TYPES = new Set(['shape', 'card', 'text', 'poll', 'bullets', 'embed', 'image']);
const TEXT_COLOR_WIDGET_TYPES = new Set(['text', 'card', 'poll', 'bullets', 'embed']);

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

function clampRatingMax(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 10;
    return Math.max(1, Math.min(10, parsed));
}

function clampDurationSeconds(value) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(86400, parsed));
}

function getPollQuestions(properties = {}) {
    return Array.isArray(properties.questions) ? properties.questions : [];
}

function createPollQuestionId(index) {
    return `q${index + 1}`;
}

function createNextPollQuestionId(questions = []) {
    const used = new Set(questions.map((question) => String(question.id || '').trim()).filter(Boolean));
    let index = 0;
    while (used.has(createPollQuestionId(index))) {
        index += 1;
    }
    return createPollQuestionId(index);
}

function normalizePollQuestionMode(question = {}) {
    return String(question.pollMode || question.voteMode || 'choice').trim() === 'rating' ? 'rating' : 'choice';
}

function normalizeBulletsStatus(value = '') {
    const normalized = String(value || '').trim();
    return ['todo', 'inProgress', 'done', 'blocked'].includes(normalized) ? normalized : 'todo';
}

function normalizeBulletsPriority(value = '') {
    const normalized = String(value || '').trim();
    return ['high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
}

function createBulletsItemId(index) {
    return `b${index + 1}`;
}

function createNextBulletsItemId(items = []) {
    const used = new Set(items.map((item) => String(item.id || '').trim()).filter(Boolean));
    let index = 0;
    while (used.has(createBulletsItemId(index))) {
        index += 1;
    }
    return createBulletsItemId(index);
}

function getWidgetEditorTitle(type = '') {
    const titles = {
        text: 'Edit text',
        card: 'Edit card',
        poll: 'Edit poll',
        bullets: 'Edit bullets',
        shape: 'Edit shape',
        line: 'Edit line',
        image: 'Edit image',
        embed: 'Edit embed'
    };
    return titles[String(type || '').trim()] || 'Edit widget';
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
        this.tabs = Array.from(this.element.querySelectorAll('[data-tab]'));
        this.contentTab = this.element.querySelector('[data-role="contentTab"]');
        this.settingsTab = this.element.querySelector('[data-role="settingsTab"]');
        this.contentPanel = this.element.querySelector('[data-role="contentPanel"]');
        this.settingsPanel = this.element.querySelector('[data-role="settingsPanel"]');
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
        this.questionsField = this.element.querySelector('[data-role="questionsField"]');
        this.questionsHost = this.element.querySelector('[data-role="questions"]');
        this.addQuestionButton = this.element.querySelector('[data-role="addQuestion"]');
        this.bulletsSection = this.element.querySelector('[data-role="bulletsSection"]');
        this.bulletsTitleInput = this.element.querySelector('[data-role="bulletsTitle"]');
        this.bulletsItemTemplate = this.element.querySelector('[data-role="bulletsItemTemplate"]');
        this.bulletsItemsHost = this.element.querySelector('[data-role="bulletsItems"]');
        this.addBulletsItemButton = this.element.querySelector('[data-role="addBulletsItem"]');
        this.resultsVisibilityInput = this.element.querySelector('[data-role="resultsVisibility"]');
        this.pollSettingsSection = this.element.querySelector('[data-role="pollSettingsSection"]');
        this.allowPollChangeField = this.element.querySelector('[data-role="allowPollChangeField"]');
        this.allowPollChangeInput = this.element.querySelector('[data-role="allowPollChange"]');
        this.anonymousField = this.element.querySelector('[data-role="anonymousField"]');
        this.anonymousInput = this.element.querySelector('[data-role="anonymous"]');
        this.durationField = this.element.querySelector('[data-role="durationField"]');
        this.durationInput = this.element.querySelector('[data-role="durationSeconds"]');
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
        for (const tab of this.tabs || []) {
            tab.addEventListener('click', () => this.activateTab(tab.dataset.tab));
        }
        this.fillTransparentInput?.addEventListener('change', () => this.syncFillControlState());
        this.addQuestionButton?.addEventListener('click', () => this.addPollQuestion());
        this.addBulletsItemButton?.addEventListener('click', () => this.addBulletsItem());
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

    activateTab(tabName = 'content') {
        const normalized = String(tabName || 'content').trim() === 'settings' ? 'settings' : 'content';
        const isSettings = normalized === 'settings';
        this.contentPanel.hidden = isSettings;
        this.settingsPanel.hidden = !isSettings;
        for (const tab of this.tabs || []) {
            const active = String(tab.dataset.tab || '') === normalized;
            tab.classList.toggle('active', active);
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        }
    }

    addPollQuestion() {
        const questions = this.readPollQuestionsFromForm();
        questions.push({
            id: createNextPollQuestionId(questions),
            prompt: '',
            pollMode: 'choice',
            options: ['Yes', 'No'],
            ratingMax: 10
        });
        this.renderPollQuestionInputs(questions);
        const inputs = Array.from(this.questionsHost?.querySelectorAll?.('[data-role="questionPrompt"]') || []);
        inputs.at(-1)?.focus?.();
    }

    removePollQuestion(questionId) {
        const questions = this.readPollQuestionsFromForm().filter((question) => question.id !== questionId);
        this.renderPollQuestionInputs(questions.length ? questions : [{
            id: createPollQuestionId(0),
            prompt: '',
            pollMode: 'choice',
            options: ['Yes', 'No'],
            ratingMax: 10
        }]);
    }

    readPollQuestionsFromForm() {
        const rows = Array.from(this.questionsHost?.querySelectorAll?.('[data-role="questionRow"]') || []);
        const questions = [];
        rows.forEach((row, index) => {
            const pollModeInput = row.querySelector('[data-role="questionPollMode"]');
            const optionsInput = row.querySelector('[data-role="questionOptions"]');
            const promptInput = row.querySelector('[data-role="questionPrompt"]');
            const ratingMaxInput = row.querySelector('[data-role="questionRatingMax"]');
            const pollMode = String(pollModeInput?.value || 'choice').trim() === 'rating' ? 'rating' : 'choice';
            const options = String(optionsInput?.value || '')
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean);
            questions.push({
                id: String(row.dataset.questionId || createPollQuestionId(index)).trim() || createPollQuestionId(index),
                prompt: String(promptInput?.value || '').trim(),
                pollMode,
                options,
                ratingMax: clampRatingMax(ratingMaxInput?.value)
            });
        });
        return questions;
    }

    addBulletsItem() {
        const items = this.readBulletsItemsFromForm();
        items.push({
            id: createNextBulletsItemId(items),
            text: '',
            status: 'todo',
            priority: 'medium'
        });
        this.renderBulletsItemInputs(items);
        const inputs = Array.from(this.bulletsItemsHost?.querySelectorAll?.('[data-role="bulletsItemText"]') || []);
        inputs.at(-1)?.focus?.();
    }

    removeBulletsItem(itemId) {
        const items = this.readBulletsItemsFromForm().filter((item) => item.id !== itemId);
        this.renderBulletsItemInputs(items);
    }

    readBulletsItemsFromForm() {
        const rows = Array.from(this.bulletsItemsHost?.querySelectorAll?.('[data-role="bulletsItemRow"]') || []);
        return rows.map((row, index) => {
            const textInput = row.querySelector('[data-role="bulletsItemText"]');
            const statusInput = row.querySelector('[data-role="bulletsItemStatus"]');
            const priorityInput = row.querySelector('[data-role="bulletsItemPriority"]');
            return {
                id: String(row.dataset.itemId || createBulletsItemId(index)).trim() || createBulletsItemId(index),
                text: String(textInput?.value || '').trim(),
                status: normalizeBulletsStatus(statusInput?.value),
                priority: normalizeBulletsPriority(priorityInput?.value)
            };
        });
    }

    renderBulletsItemInputs(items = []) {
        if (!this.bulletsItemsHost) return;
        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
            const row = this.createBulletsItemRowTemplate(item, index);
            const textInput = row.querySelector('[data-role="bulletsItemText"]');
            const statusSelect = row.querySelector('[data-role="bulletsItemStatus"]');
            const prioritySelect = row.querySelector('[data-role="bulletsItemPriority"]');
            const removeButton = row.querySelector('.webmeet-blackboard-remove-question-button');
            if (textInput) textInput.value = String(item.text || '');
            if (statusSelect) statusSelect.value = normalizeBulletsStatus(item.status);
            if (prioritySelect) prioritySelect.value = normalizeBulletsPriority(item.priority);
            removeButton?.addEventListener('click', () => this.removeBulletsItem(row.dataset.itemId));
            fragment.append(row);
        });
        this.bulletsItemsHost.replaceChildren(fragment);
    }

    createBulletsItemRowTemplate(item = {}, index = 0) {
        const row = this.bulletsItemTemplate?.content?.firstElementChild?.cloneNode(true) || document.createElement('div');
        row.classList.add('webmeet-blackboard-bullets-editor-row');
        row.dataset.role = 'bulletsItemRow';
        row.dataset.itemId = String(item.id || createBulletsItemId(index)).trim() || createBulletsItemId(index);
        const textInput = row.querySelector('[data-role="bulletsItemText"]');
        textInput?.setAttribute('aria-label', `Bullet ${index + 1}`);
        const removeButton = row.querySelector('.webmeet-blackboard-bullets-remove-button');
        removeButton?.setAttribute('aria-label', `Remove bullet ${index + 1}`);
        return row;
    }

    syncPollQuestionRow(row) {
        const mode = String(row?.querySelector?.('[data-role="questionPollMode"]')?.value || 'choice').trim() === 'rating' ? 'rating' : 'choice';
        const optionsField = row?.querySelector?.('[data-role="questionOptionsField"]');
        const ratingField = row?.querySelector?.('[data-role="questionRatingMaxField"]');
        if (optionsField) optionsField.hidden = mode === 'rating';
        if (ratingField) ratingField.hidden = mode !== 'rating';
    }

    renderPollQuestionInputs(questions = []) {
        if (!this.questionsHost) return;
        const normalizedQuestions = questions.length ? questions : [{
            id: createPollQuestionId(0),
            prompt: '',
            pollMode: 'choice',
            options: ['Yes', 'No'],
            ratingMax: 10
        }];
        const fragment = document.createDocumentFragment();
        normalizedQuestions.forEach((question, index) => {
            const row = document.createElement('div');
            row.className = 'webmeet-blackboard-poll-question-row';
            row.dataset.role = 'questionRow';
            row.dataset.questionId = String(question.id || createPollQuestionId(index)).trim() || createPollQuestionId(index);

            const header = document.createElement('div');
            header.className = 'webmeet-blackboard-poll-question-row-header';
            const heading = document.createElement('div');
            heading.className = 'webmeet-blackboard-poll-question-heading';
            heading.textContent = `Question ${index + 1}`;
            const removeButton = document.createElement('button');
            removeButton.type = 'button';
            removeButton.className = 'gray-button webmeet-blackboard-remove-question-button';
            removeButton.textContent = 'Remove';
            removeButton.disabled = normalizedQuestions.length <= 1;
            removeButton.addEventListener('click', () => this.removePollQuestion(row.dataset.questionId));
            header.append(heading, removeButton);

            const controls = document.createElement('div');
            controls.className = 'webmeet-blackboard-poll-question-controls';

            const promptField = document.createElement('label');
            promptField.className = 'webmeet-form-field webmeet-blackboard-poll-question-field webmeet-blackboard-poll-question-prompt';
            const promptLabel = document.createElement('span');
            promptLabel.textContent = 'Prompt';
            const promptInput = document.createElement('input');
            promptInput.className = 'form-input';
            promptInput.type = 'text';
            promptInput.value = String(question.prompt || '');
            promptInput.placeholder = `Question ${index + 1}`;
            promptInput.dataset.role = 'questionPrompt';
            promptInput.setAttribute('aria-label', `Question ${index + 1}`);
            promptField.append(promptLabel, promptInput);

            const modeField = document.createElement('label');
            modeField.className = 'webmeet-form-field webmeet-blackboard-poll-question-field';
            const modeLabel = document.createElement('span');
            modeLabel.textContent = 'Type';
            const modeSelect = document.createElement('select');
            modeSelect.className = 'form-input';
            modeSelect.dataset.role = 'questionPollMode';
            for (const [value, label] of [['choice', 'Choice'], ['rating', 'Rating']]) {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = label;
                modeSelect.append(option);
            }
            modeSelect.value = normalizePollQuestionMode(question);
            modeSelect.addEventListener('change', () => this.syncPollQuestionRow(row));
            modeField.append(modeLabel, modeSelect);

            const optionsField = document.createElement('label');
            optionsField.className = 'webmeet-form-field webmeet-blackboard-poll-question-field webmeet-blackboard-poll-question-options';
            optionsField.dataset.role = 'questionOptionsField';
            const optionsLabel = document.createElement('span');
            optionsLabel.textContent = 'Options';
            const optionsInput = document.createElement('input');
            optionsInput.className = 'form-input';
            optionsInput.type = 'text';
            optionsInput.value = Array.isArray(question.options) && question.options.length ? question.options.join(', ') : 'Yes, No';
            optionsInput.dataset.role = 'questionOptions';
            optionsInput.setAttribute('aria-label', `Options for question ${index + 1}`);
            optionsField.append(optionsLabel, optionsInput);

            const ratingField = document.createElement('label');
            ratingField.className = 'webmeet-form-field webmeet-blackboard-poll-question-field';
            ratingField.dataset.role = 'questionRatingMaxField';
            const ratingLabel = document.createElement('span');
            ratingLabel.textContent = 'Rating max';
            const ratingInput = document.createElement('input');
            ratingInput.className = 'form-input';
            ratingInput.type = 'number';
            ratingInput.min = '1';
            ratingInput.max = '10';
            ratingInput.step = '1';
            ratingInput.value = String(clampRatingMax(question.ratingMax));
            ratingInput.dataset.role = 'questionRatingMax';
            ratingInput.setAttribute('aria-label', `Rating max for question ${index + 1}`);
            ratingField.append(ratingLabel, ratingInput);

            controls.append(promptField, modeField, optionsField, ratingField);
            row.append(header, controls);
            this.syncPollQuestionRow(row);
            fragment.append(row);
        });
        this.questionsHost.replaceChildren(fragment);
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
            if (this.title) this.title.textContent = 'Widget unavailable';
            if (this.textSection) this.textSection.hidden = true;
            if (this.typographySection) this.typographySection.hidden = true;
            if (this.choiceSection) this.choiceSection.hidden = true;
            if (this.bulletsSection) this.bulletsSection.hidden = true;
            if (this.pollSettingsSection) this.pollSettingsSection.hidden = true;
            if (this.lineSection) this.lineSection.hidden = true;
            if (this.surfaceSection) this.surfaceSection.hidden = true;
            this.activateTab('content');
            if (this.saveButton) this.saveButton.disabled = true;
            return;
        }
        if (this.saveButton) this.saveButton.disabled = false;
        const type = String(widget?.type || 'widget').trim() || 'widget';
        const props = widget?.properties || {};
        const style = props.style || {};
        const typeDefaults = this.getTypeDefaults(type);
        const isChoice = CHOICE_WIDGET_TYPES.has(type);
        const isPoll = type === 'poll';
        const isBullets = type === 'bullets';
        const isLine = type === 'line';
        const isSurface = SURFACE_WIDGET_TYPES.has(type) || isLine;
        const hasText = TEXT_WIDGET_TYPES.has(type) || isChoice;
        const hasTypography = type === 'text';
        const hasTextColor = TEXT_COLOR_WIDGET_TYPES.has(type) && !hasTypography;

        if (this.title) this.title.textContent = getWidgetEditorTitle(type);

        if (this.textSection) this.textSection.hidden = !hasText;
        if (this.textInput) this.textInput.value = this.getWidgetText(widget);
        if (this.textLabel) this.textLabel.textContent = isPoll ? 'Description' : (isChoice ? 'Question' : 'Text');
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
        if (this.bulletsSection) this.bulletsSection.hidden = !isBullets;
        if (isBullets) {
            if (this.bulletsTitleInput) this.bulletsTitleInput.value = String(props.title || 'Meeting Bullets').trim() || 'Meeting Bullets';
            this.renderBulletsItemInputs((Array.isArray(props.items) ? props.items : []).map((item, index) => ({
                id: String(item.id || createBulletsItemId(index)).trim() || createBulletsItemId(index),
                text: String(item.text || '').trim(),
                status: normalizeBulletsStatus(item.status),
                priority: normalizeBulletsPriority(item.priority)
            })));
        } else if (this.bulletsItemsHost) {
            this.bulletsItemsHost.replaceChildren();
        }
        if (this.questionsField) this.questionsField.hidden = !isPoll;
        if (this.pollSettingsSection) this.pollSettingsSection.hidden = !isPoll;
        if (isPoll) {
            this.renderPollQuestionInputs(getPollQuestions(props).map((question, index) => ({
                id: String(question.id || createPollQuestionId(index)).trim() || createPollQuestionId(index),
                prompt: String(question.prompt || '').trim(),
                pollMode: normalizePollQuestionMode(question),
                options: Array.isArray(question.options) ? question.options : [],
                ratingMax: clampRatingMax(question.ratingMax)
            })));
        } else if (this.questionsHost) {
            this.questionsHost.replaceChildren();
        }
        if (this.resultsVisibilityInput) {
            this.resultsVisibilityInput.value = props.resultsVisibility || props.aggregation?.resultsVisibility || (isPoll ? 'public' : 'moderatorsOnly');
        }
        if (this.allowPollChangeField) this.allowPollChangeField.hidden = !isPoll;
        if (this.allowPollChangeInput) this.allowPollChangeInput.checked = props.allowPollChange === true;
        if (this.anonymousField) this.anonymousField.hidden = !isPoll;
        if (this.anonymousInput) this.anonymousInput.checked = props.anonymous === true;
        if (this.durationField) this.durationField.hidden = !isPoll;
        if (this.durationInput) this.durationInput.value = String(clampDurationSeconds(props.durationSeconds));

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
        this.activateTab(hasText || isPoll || isBullets ? 'content' : 'settings');
    }

    getWidgetText(widget = {}) {
        const props = widget?.properties || {};
        if (widget?.type === 'poll') return props.description || '';
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

        if (type === 'poll') {
            patch.properties.description = text;
        } else if (type === 'bullets') {
            patch.properties.title = String(this.bulletsTitleInput?.value || 'Meeting Bullets').trim() || 'Meeting Bullets';
            patch.properties.items = this.readBulletsItemsFromForm()
                .filter((item) => item.text)
                .map((item, index) => ({
                    id: String(item.id || createBulletsItemId(index)).trim() || createBulletsItemId(index),
                    text: item.text,
                    status: item.status,
                    priority: item.priority
                }));
        } else if (type === 'text' || type === 'card') {
            patch.properties.text = text;
        }

        if (CHOICE_WIDGET_TYPES.has(type)) {
            patch.properties.resultsVisibility = String(this.resultsVisibilityInput?.value || 'moderatorsOnly').trim();
            if (type === 'poll') {
                const questions = this.readPollQuestionsFromForm()
                    .filter((question) => question.prompt);
                patch.properties.questions = questions.map((question, index) => ({
                    id: String(question.id || createPollQuestionId(index)).trim() || createPollQuestionId(index),
                    prompt: question.prompt,
                    pollMode: question.pollMode,
                    options: question.pollMode === 'choice' ? question.options : [],
                    ratingMax: question.ratingMax
                }));
                patch.properties.allowPollChange = this.allowPollChangeInput?.checked === true;
                patch.properties.anonymous = this.anonymousInput?.checked === true;
                patch.properties.durationSeconds = clampDurationSeconds(this.durationInput?.value);
            }
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
