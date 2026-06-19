function readJsonAttribute(element, attributeName) {
    const raw = String(element?.getAttribute(attributeName) || '').trim();
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
}

export class WebMeetBlackboardPollModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.widget = readJsonAttribute(element, 'data-widget-json');
        this.participantId = String(decodeURIComponent(element?.getAttribute('data-participant-id') || '') || '').trim();
        this.participantName = String(decodeURIComponent(element?.getAttribute('data-participant-name') || '') || '').trim();
        this.result = null;
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.renderPoll();
        this.form?.addEventListener('submit', (event) => this.submitPoll(event));
    }

    cacheElements() {
        this.form = this.element.querySelector('[data-role="form"]');
        this.title = this.element.querySelector('[data-role="title"]');
        this.subtitle = this.element.querySelector('[data-role="subtitle"]');
        this.description = this.element.querySelector('[data-role="description"]');
        this.questionsHost = this.element.querySelector('[data-role="questions"]');
        this.submitButton = this.element.querySelector('[data-role="submit"]');
    }

    renderPoll() {
        const props = this.widget?.properties || {};
        const questions = this.getQuestions();
        if (this.title) this.title.textContent = props.description || 'Poll';
        if (this.subtitle) this.subtitle.textContent = this.getStatusText();
        if (this.description) this.description.textContent = props.description || '';
        if (this.submitButton) this.submitButton.disabled = this.isLocked() || questions.length === 0;
        this.questionsHost?.replaceChildren(...questions.map((question) => this.renderQuestion(question)));
    }

    getQuestions() {
        return Array.isArray(this.widget?.properties?.questions) ? this.widget.properties.questions : [];
    }

    getCurrentAnswers() {
        const participantData = this.widget?.properties?.participantData || {};
        if (this.participantId && participantData[this.participantId]?.answers) {
            return participantData[this.participantId].answers;
        }
        return {};
    }

    isLocked() {
        const props = this.widget?.properties || {};
        const status = String(props.status || 'open').trim();
        if (status === 'closed' || status === 'draft') return true;
        if (props.closesAt && Date.now() >= Date.parse(String(props.closesAt))) return true;
        return Boolean(Object.keys(this.getCurrentAnswers()).length && props.allowPollChange !== true);
    }

    getStatusText() {
        const props = this.widget?.properties || {};
        if (String(props.status || '').trim() === 'draft') return 'Poll has not started';
        if (this.isLocked() && Object.keys(this.getCurrentAnswers()).length) return 'Poll submitted';
        if (String(props.status || '').trim() === 'closed') return 'Poll closed';
        return 'Select an answer for each question';
    }

    renderQuestion(question) {
        const currentAnswers = this.getCurrentAnswers();
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'webmeet-blackboard-poll-modal-question';
        const legend = document.createElement('legend');
        legend.className = 'webmeet-blackboard-poll-modal-question-title';
        legend.textContent = question.prompt;
        const options = document.createElement('div');
        options.className = 'webmeet-blackboard-poll-modal-options';
        for (const option of Array.isArray(question.options) ? question.options : []) {
            const value = String(option || '').trim();
            if (!value) continue;
            const label = document.createElement('label');
            label.className = 'webmeet-blackboard-poll-modal-option';
            const input = document.createElement('input');
            input.type = 'radio';
            input.name = question.id;
            input.value = value;
            input.checked = currentAnswers[question.id] === value;
            input.disabled = this.isLocked();
            label.append(input, document.createTextNode(value));
            options.append(label);
        }
        fieldset.append(legend, options);
        return fieldset;
    }

    submitPoll(event) {
        event.preventDefault();
        const answers = {};
        const checkedInputs = Array.from(this.form?.querySelectorAll?.('input[type="radio"]:checked') || []);
        for (const question of this.getQuestions()) {
            const input = checkedInputs.find((candidate) => candidate.name === question.id);
            const value = String(input?.value || '').trim();
            if (!value) return;
            answers[question.id] = value;
        }
        this.result = {
            answers,
            participantName: this.participantName || this.participantId
        };
        this.closeModal();
    }

    closeModal() {
        globalThis.assistOS?.UI?.closeModal?.(this.element, this.result);
    }
}
