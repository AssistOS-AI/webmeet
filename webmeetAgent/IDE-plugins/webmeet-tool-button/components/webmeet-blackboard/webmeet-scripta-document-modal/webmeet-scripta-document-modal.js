function modalMode(element) {
    return String(element?.getAttribute('data-mode') || 'create').trim() === 'open' ? 'open' : 'create';
}

function readEntries(element) {
    try {
        return JSON.parse(decodeURIComponent(String(element?.getAttribute('data-entries-json') || '')));
    } catch {
        return {};
    }
}

function markdownDocuments(entries) {
    return [...new Set((Array.isArray(entries?.documents) ? entries.documents : [])
        .map((documentPath) => String(documentPath || '').trim())
        .filter((documentPath) => documentPath && /\.md$/i.test(documentPath)))]
        .sort((left, right) => left.localeCompare(right));
}

export class WebMeetScriptaDocumentModal {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.result = null;
        this.mode = modalMode(element);
        this.canBrowseWorkspace = String(element?.getAttribute('data-can-browse') || '') === 'true';
        this.entries = readEntries(element);
        this.documents = markdownDocuments(this.entries);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        const create = this.mode === 'create';
        this.element.querySelector('[data-role="title"]').textContent = create ? 'Create SCRIPTA document' : 'Open SCRIPTA document';
        this.element.querySelector('[data-role="submit"]').textContent = create ? 'Create' : 'Open';
        for (const role of ['nameField', 'templateField']) {
            this.element.querySelector(`[data-role="${role}"]`).hidden = !create;
        }
        this.element.querySelector('[data-role="folderField"]').hidden = !create || !this.canBrowseWorkspace;
        this.element.querySelector('[data-role="pathField"]').hidden = create;
        const folderSelect = this.element.querySelector('[data-role="folder"]');
        for (const folder of this.entries.folders || []) folderSelect.append(new Option(folder, folder));
        const pathSearch = this.element.querySelector('[data-role="pathSearch"]');
        pathSearch.addEventListener('input', () => this.renderDocuments(pathSearch.value));
        this.element.querySelector('[data-role="path"]').addEventListener('dblclick', () => this.submit());
        this.element.querySelector('[data-role="template"]').addEventListener('change', () => this.updateObjective());
        this.element.querySelector('[data-role="form"]').addEventListener('submit', (event) => {
            event.preventDefault();
            this.submit();
        });
        this.renderDocuments();
        this.updateObjective();
        const initialControl = create
            ? this.element.querySelector('[data-role="name"]')
            : pathSearch;
        globalThis.queueMicrotask?.(() => initialControl?.focus());
    }

    renderDocuments(search = '') {
        const query = String(search || '').trim().toLocaleLowerCase();
        const matches = query
            ? this.documents.filter((documentPath) => documentPath.toLocaleLowerCase().includes(query))
            : this.documents;
        const select = this.element.querySelector('[data-role="path"]');
        select.replaceChildren(...matches.map((documentPath) => new Option(documentPath, documentPath)));
        select.disabled = matches.length === 0;
        if (this.mode === 'open') this.element.querySelector('[data-role="submit"]').disabled = matches.length === 0;
        if (matches.length) select.value = matches[0];
        const status = this.element.querySelector('[data-role="pathStatus"]');
        if (!this.documents.length) status.textContent = 'No Markdown documents were found in the workspace.';
        else if (!matches.length) status.textContent = 'No Markdown documents match this search.';
        else status.textContent = `${matches.length} Markdown ${matches.length === 1 ? 'document' : 'documents'}`;
    }

    updateObjective() {
        const template = this.element.querySelector('[data-role="template"]').value;
        const usesObjective = this.mode === 'create' && (template === 'vision' || template === 'plan');
        this.element.querySelector('[data-role="objectiveField"]').hidden = !usesObjective;
        if (!usesObjective) this.element.querySelector('[data-role="objective"]').value = '';
    }

    showError(message) {
        const node = this.element.querySelector('[data-role="error"]');
        node.textContent = message;
        node.hidden = false;
    }

    submit() {
        if (this.mode === 'open') {
            const path = this.element.querySelector('[data-role="path"]').value.trim();
            if (!path) return this.showError('Select a Markdown document.');
            if (!this.documents.includes(path)) return this.showError('Select a Markdown document from the workspace list.');
            this.result = { mode: 'open', path };
        } else {
            const name = this.element.querySelector('[data-role="name"]').value.trim();
            const template = this.element.querySelector('[data-role="template"]').value;
            const objective = this.element.querySelector('[data-role="objective"]').value.trim();
            const folderPath = this.canBrowseWorkspace ? this.element.querySelector('[data-role="folder"]').value.trim() : '';
            if (!name) return this.showError('Enter a document name.');
            const usesObjective = template === 'vision' || template === 'plan';
            if (usesObjective && !objective) return this.showError('Vision and Plan require a work objective.');
            this.result = {
                mode: 'create',
                name,
                template,
                ...(usesObjective ? { objective } : {}),
                ...(folderPath ? { folderPath } : {}),
            };
        }
        globalThis.assistOS.UI.closeModal(this.element, this.result);
    }

    closeModal() {
        globalThis.assistOS.UI.closeModal(this.element, null);
    }
}
