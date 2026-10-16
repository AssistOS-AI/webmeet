function readJsonAttribute(element, attributeName) {
    const raw = String(element?.getAttribute(attributeName) || '').trim();
    if (!raw) return null;
    return JSON.parse(decodeURIComponent(raw));
}

export class WebMeetBlackboardPollResultsModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.widget = readJsonAttribute(element, 'data-widget-json');
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.cacheElements();
        this.renderResults();
    }

    closeModal() {
        globalThis.assistOS?.UI?.closeModal?.(this.element, null);
    }

    cacheElements() {
        this.title = this.element.querySelector('[data-role="title"]');
        this.subtitle = this.element.querySelector('[data-role="subtitle"]');
        this.description = this.element.querySelector('[data-role="description"]');
        this.resultsHost = this.element.querySelector('[data-role="results"]');
        this.participantsSection = this.element.querySelector('[data-role="participantsSection"]');
        this.participantsHost = this.element.querySelector('[data-role="participants"]');
    }

    renderResults() {
        const props = this.widget?.properties || {};
        if (this.title) this.title.textContent = props.description || 'Poll results';
        if (this.subtitle) this.subtitle.textContent = 'Final results';
        if (this.description) this.description.textContent = props.description || '';
        this.resultsHost?.replaceChildren(...this.getQuestions().map((question) => this.renderQuestion(question)));
        this.renderParticipants();
    }

    getQuestions() {
        return Array.isArray(this.widget?.properties?.questions) ? this.widget.properties.questions : [];
    }

    renderQuestion(question) {
        const questionRow = document.createElement('section');
        questionRow.className = 'webmeet-blackboard-poll-question-row';
        const title = document.createElement('div');
        title.className = 'webmeet-blackboard-poll-modal-question-title';
        title.textContent = question.prompt;
        const results = document.createElement('div');
        results.className = 'webmeet-blackboard-poll-results';
        const group = this.getQuestionAggregation(question);
        for (const option of Array.isArray(question.options) ? question.options : []) {
            const value = String(option || '').trim();
            if (!value) continue;
            const count = Number(group.counts?.[value] || 0) || 0;
            const total = Number(group.total || 0) || 0;
            if (total > 0 && count === 0) continue;
            const percent = total > 0 ? Math.round((count / total) * 100) : 0;
            const row = document.createElement('div');
            row.className = 'webmeet-blackboard-poll-result';
            const label = document.createElement('span');
            label.className = 'webmeet-blackboard-poll-result-label';
            label.textContent = value;
            const bar = document.createElement('span');
            bar.className = 'webmeet-blackboard-poll-result-bar';
            bar.style.setProperty('--poll-result-width', `${percent}%`);
            const valueEl = document.createElement('span');
            valueEl.className = 'webmeet-blackboard-poll-result-value';
            valueEl.textContent = `${count} (${percent}%)`;
            row.append(label, bar, valueEl);
            results.append(row);
        }
        if (!results.children.length) {
            const empty = document.createElement('div');
            empty.className = 'webmeet-blackboard-poll-result-empty';
            empty.textContent = 'No polls were submitted';
            results.append(empty);
        }
        questionRow.append(title, results);
        return questionRow;
    }

    getQuestionAggregation(question) {
        const aggregation = this.widget?.properties?.aggregation || null;
        const questionAggregation = aggregation?.questions || null;
        if (!questionAggregation || typeof questionAggregation !== 'object') {
            return { counts: {}, total: 0 };
        }
        const group = questionAggregation[question.id] || {};
        const counts = group.counts || {};
        return {
            counts,
            total: Number(group.total ?? Object.values(counts).reduce((sum, count) => sum + (Number(count) || 0), 0)) || 0
        };
    }

    renderParticipants() {
        if (!this.participantsHost || !this.participantsSection) return;
        const table = this.createParticipantTable();
        this.participantsSection.hidden = !table;
        this.participantsHost.replaceChildren(...(table ? [table] : []));
    }

    createParticipantTable() {
        if (this.widget?.properties?.anonymous === true) return null;
        const participantData = this.widget?.properties?.participantData || {};
        const entries = Object.entries(participantData).filter(([, entry]) => Object.keys(entry?.answers || {}).length > 0);
        if (!entries.length) return null;
        const tableWrap = document.createElement('div');
        tableWrap.className = 'webmeet-blackboard-poll-table-wrap';
        const table = document.createElement('table');
        table.className = 'webmeet-blackboard-poll-table';
        const thead = document.createElement('thead');
        const headRow = document.createElement('tr');
        for (const labelText of ['Participant', 'Poll']) {
            const th = document.createElement('th');
            th.textContent = labelText;
            headRow.append(th);
        }
        thead.append(headRow);
        const tbody = document.createElement('tbody');
        for (const [participantId, entry] of entries) {
            const row = document.createElement('tr');
            const participantCell = document.createElement('td');
            participantCell.textContent = this.getParticipantDisplayName(participantId, entry);
            const pollCell = document.createElement('td');
            pollCell.textContent = Object.values(entry.answers || {}).join(', ');
            row.append(participantCell, pollCell);
            tbody.append(row);
        }
        table.append(thead, tbody);
        tableWrap.append(table);
        return tableWrap;
    }

    getParticipantDisplayName(participantId, entry = {}) {
        const name = String(entry.participantName || entry.displayName || entry.name || '').trim();
        return name || String(participantId || '').trim();
    }
}
