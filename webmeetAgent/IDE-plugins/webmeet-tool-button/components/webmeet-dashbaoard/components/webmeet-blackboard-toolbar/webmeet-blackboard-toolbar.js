export class WebMeetBlackboardToolbar {
    constructor(element, invalidate) {
        this.element = element;
        this.invalidate = invalidate;
        this.activeTool = 'select';
        this.busy = false;
        this.background = { color: '#ffffff' };
        this.handleChange = (event) => this.handleToolbarChange(event);
        this.element.setState = (state) => this.setState(state);
        this.invalidate();
    }

    beforeRender() {}

    afterRender() {
        this.bindEvents();
        this.renderState();
    }

    setState({ activeTool = 'select', busy = false, background } = {}) {
        this.activeTool = activeTool;
        this.busy = busy;
        if (background) {
            this.background = { ...this.background, ...background };
        }
        this.renderState();
    }

    bindEvents() {
        this.element.removeEventListener('change', this.handleChange);
        this.element.addEventListener('change', this.handleChange);
    }

    setTool(_target, tool = 'select') {
        const normalizedTool = String(tool || 'select').trim() || 'select';
        if (_target?.disabled) return;
        this.emit('blackboard-tool', { tool: normalizedTool });
    }

    addWidget(_target, type = 'shape') {
        const normalizedType = String(type || 'shape').trim() || 'shape';
        if (_target?.disabled) return;
        this.emit('blackboard-add-widget', { type: normalizedType });
    }

    runToolbarAction(_target, action = '') {
        const normalizedAction = String(action || '').trim();
        if (!normalizedAction || _target?.disabled) return;
        this.emit('blackboard-action', { action: normalizedAction });
    }

    handleToolbarChange(event) {
        const backgroundColor = event.target?.closest?.('[data-background-color]');
        if (backgroundColor && this.element.contains(backgroundColor)) {
            this.emit('blackboard-background', { background: { color: backgroundColor.value } });
        }
    }

    renderState() {
        for (const button of this.element.querySelectorAll('button')) {
            button.disabled = Boolean(this.busy);
        }
        for (const button of this.element.querySelectorAll('[data-local-action^="setTool "]')) {
            const [, tool = ''] = String(button.getAttribute('data-local-action') || '').trim().split(/\s+/);
            button.classList.toggle('is-active', tool === this.activeTool);
        }
        const backgroundColor = this.element.querySelector('[data-background-color]');
        if (backgroundColor && backgroundColor.value !== this.background.color) {
            backgroundColor.value = this.background.color || '#ffffff';
        }
    }

    emit(type, detail) {
        this.element.dispatchEvent(new CustomEvent(type, {
            bubbles: true,
            composed: true,
            detail
        }));
    }
}
