export const blackboardRenderingMethods = {
    renderWidgets() {
        if (!this.board) return;
        this.applyBoardBackground();
        const fragment = document.createDocumentFragment();
        this.widgetNodes.clear();
        for (const widget of this.blackboard?.widgets || []) {
            const node = this.renderWidget(widget);
            fragment.append(node);
            this.widgetNodes.set(widget.id, node);
        }
        this.board.replaceChildren(fragment);
        this.updateToolbarState();
    },

    renderWidget(widget) {
        const node = document.createElement('div');
        const geometry = widget.properties?.geometry || {};
        const style = widget.properties?.style || {};
        node.className = `webmeet-blackboard-widget ${widget.type || 'shape'}`;
        node.classList.toggle('is-locked', Boolean(widget.locked));
        node.dataset.widgetId = widget.id;
        node.setAttribute('aria-selected', String(this.selection === widget.id));
        node.style.left = `${Number(geometry.x || 0)}px`;
        node.style.top = `${Number(geometry.y || 0)}px`;
        node.style.width = `${Number(geometry.width || 120)}px`;
        node.style.height = `${Number(geometry.height || 64)}px`;
        if (style.fill) node.style.setProperty('--fill', style.fill);
        if (style.stroke) node.style.setProperty('--stroke', style.stroke);
        if (style.strokeWidth) node.style.setProperty('--stroke-width', String(style.strokeWidth));
        this.renderWidgetContent(node, widget);
        this.renderResizeHandles(node, widget);
        node.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        node.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.editWidget(widget);
        });
        return node;
    },

    canResizeWidget(widget) {
        if (!widget || widget.locked) return false;
        return ['shape', 'line', 'card', 'text'].includes(String(widget.type || 'shape').trim() || 'shape');
    },

    renderResizeHandles(node, widget) {
        if (!this.canResizeWidget(widget)) return;
        if (widget.type === 'line') {
            const geometry = widget.properties?.geometry || {};
            const line = widget.properties?.line || {};
            const width = Math.max(1, Number(geometry.width || 220) || 220);
            const height = Math.max(1, Number(geometry.height || 80) || 80);
            const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
            const handles = [
                {name: 'line-start', x: Number(line.x1 ?? endpoints.x1), y: Number(line.y1 ?? endpoints.y1)},
                {name: 'line-end', x: Number(line.x2 ?? endpoints.x2), y: Number(line.y2 ?? endpoints.y2)}
            ];
            for (const handle of handles) {
                const resizeHandle = document.createElement('span');
                resizeHandle.className = `webmeet-blackboard-resize-handle line-endpoint ${handle.name}`;
                resizeHandle.dataset.resizeHandle = handle.name;
                resizeHandle.setAttribute('aria-hidden', 'true');
                resizeHandle.style.left = `${handle.x}px`;
                resizeHandle.style.top = `${handle.y}px`;
                resizeHandle.addEventListener('pointerdown', (event) => this.beginLocalResize(event, widget, handle.name));
                node.append(resizeHandle);
            }
            return;
        }
        for (const handle of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
            const resizeHandle = document.createElement('span');
            resizeHandle.className = `webmeet-blackboard-resize-handle ${handle}`;
            resizeHandle.dataset.resizeHandle = handle;
            resizeHandle.setAttribute('aria-hidden', 'true');
            resizeHandle.addEventListener('pointerdown', (event) => this.beginLocalResize(event, widget, handle));
            node.append(resizeHandle);
        }
    },

    renderWidgetContent(node, widget) {
        node.replaceChildren();
        if (widget.type === 'shape') {
            node.append(this.createShapeSvg(widget));
            return;
        }
        if (widget.type === 'line') {
            node.append(this.createLineSvg(widget));
            return;
        }
        if (widget.type === 'quiz' || widget.type === 'vote') {
            const title = document.createElement('div');
            title.className = 'webmeet-blackboard-widget-title';
            title.textContent = widget.properties?.prompt || widget.properties?.question || widget.type;
            const control = document.createElement('div');
            control.className = 'webmeet-blackboard-widget-control';
            const select = document.createElement('select');
            for (const option of Array.isArray(widget.properties?.options) ? widget.properties.options : []) {
                const optionEl = document.createElement('option');
                optionEl.value = String(option);
                optionEl.textContent = String(option);
                select.append(optionEl);
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Submit';
            button.addEventListener('pointerdown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.submitInteractiveWidget(widget, {value: select.value});
            });
            control.append(select, button);
            node.append(title, control);
            return;
        }
        if (widget.type === 'input') {
            const title = document.createElement('div');
            title.className = 'webmeet-blackboard-widget-title';
            title.textContent = widget.properties?.label || 'Input';
            const control = document.createElement('div');
            control.className = 'webmeet-blackboard-widget-control';
            const input = document.createElement('input');
            input.placeholder = widget.properties?.placeholder || '';
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = 'Submit';
            button.addEventListener('pointerdown', (event) => event.stopPropagation());
            button.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.submitInteractiveWidget(widget, {value: input.value});
            });
            control.append(input, button);
            node.append(title, control);
            return;
        }
        if (widget.type === 'text' || widget.type === 'card') {
            if (widget.type === 'card' && String(widget.properties?.title || '').trim()) {
                const title = document.createElement('div');
                title.className = 'webmeet-blackboard-widget-title';
                title.textContent = String(widget.properties.title || '');
                node.append(title);
            }
            const text = document.createElement('div');
            text.className = 'webmeet-blackboard-inline-text';
            text.tabIndex = 0;
            text.setAttribute('role', 'textbox');
            text.setAttribute('aria-label', 'Edit widget text');
            text.textContent = this.getEditableWidgetText(widget);
            text.addEventListener('focusin', () => this.startInlineTextEdit(widget));
            text.addEventListener('pointerdown', (event) => {
                if (text.isContentEditable) event.stopPropagation();
            });
            node.append(text);
            return;
        }
        node.textContent = this.getWidgetLabel(widget);
    },

    createSvgElement(tagName) {
        return document.createElementNS('http://www.w3.org/2000/svg', tagName);
    },

    createShapeSvg(widget) {
        const shapeKind = String(widget.properties?.shapeKind || 'rectangle').trim() || 'rectangle';
        const style = widget.properties?.style || {};
        const fill = style.fill || '#ffffff';
        const stroke = style.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || 2) || 2;
        const svg = this.createSvgElement('svg');
        svg.setAttribute('class', 'webmeet-blackboard-shape-svg');
        svg.setAttribute('viewBox', '0 0 100 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        let shape = null;
        if (shapeKind === 'ellipse') {
            shape = this.createSvgElement('ellipse');
            shape.setAttribute('cx', '50');
            shape.setAttribute('cy', '50');
            shape.setAttribute('rx', '47');
            shape.setAttribute('ry', '47');
        } else if (shapeKind === 'diamond') {
            shape = this.createSvgElement('polygon');
            shape.setAttribute('points', '50,3 97,50 50,97 3,50');
        } else if (shapeKind === 'triangle') {
            shape = this.createSvgElement('polygon');
            shape.setAttribute('points', '50,4 96,96 4,96');
        } else {
            shape = this.createSvgElement('rect');
            shape.setAttribute('x', '3');
            shape.setAttribute('y', '3');
            shape.setAttribute('width', '94');
            shape.setAttribute('height', '94');
            if (shapeKind === 'rounded') {
                shape.setAttribute('rx', '12');
                shape.setAttribute('ry', '12');
            }
        }
        shape.setAttribute('fill', fill);
        shape.setAttribute('stroke', stroke);
        shape.setAttribute('stroke-width', String(strokeWidth));
        svg.append(shape);
        return svg;
    },

    createLineSvg(widget) {
        const geometry = widget.properties?.geometry || {};
        const style = widget.properties?.style || {};
        const width = Math.max(1, Number(geometry.width || 220) || 220);
        const height = Math.max(1, Number(geometry.height || 80) || 80);
        const line = widget.properties?.line || {};
        const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
        const x1 = Number(line.x1 ?? endpoints.x1);
        const y1 = Number(line.y1 ?? endpoints.y1);
        const x2 = Number(line.x2 ?? endpoints.x2);
        const y2 = Number(line.y2 ?? endpoints.y2);
        const markerStart = String(line.markerStart || '').trim();
        const markerEnd = String(line.markerEnd || '').trim();
        const stroke = style.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || 3) || 3;
        const markerIdBase = `bb_arrow_${String(widget.id || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const svg = this.createSvgElement('svg');
        svg.setAttribute('class', 'webmeet-blackboard-line-svg');
        svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        if (markerStart === 'arrow' || markerEnd === 'arrow') {
            const defs = this.createSvgElement('defs');
            const marker = this.createSvgElement('marker');
            marker.setAttribute('id', markerIdBase);
            marker.setAttribute('viewBox', '0 0 10 10');
            marker.setAttribute('refX', '8');
            marker.setAttribute('refY', '5');
            marker.setAttribute('markerWidth', '7');
            marker.setAttribute('markerHeight', '7');
            marker.setAttribute('orient', 'auto-start-reverse');
            const path = this.createSvgElement('path');
            path.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
            path.setAttribute('fill', stroke);
            marker.append(path);
            defs.append(marker);
            svg.append(defs);
        }
        const segment = this.createSvgElement('line');
        segment.setAttribute('x1', String(x1));
        segment.setAttribute('y1', String(y1));
        segment.setAttribute('x2', String(x2));
        segment.setAttribute('y2', String(y2));
        segment.setAttribute('stroke', stroke);
        segment.setAttribute('stroke-width', String(strokeWidth));
        segment.setAttribute('stroke-linecap', 'round');
        if (markerStart === 'arrow') {
            segment.setAttribute('marker-start', `url(#${markerIdBase})`);
        }
        if (markerEnd === 'arrow') {
            segment.setAttribute('marker-end', `url(#${markerIdBase})`);
        }
        svg.append(segment);
        return svg;
    },

    getWidgetLabel(widget) {
        if (widget.type === 'text') return widget.properties?.text || '';
        if (widget.type === 'quiz' || widget.type === 'vote') return widget.properties?.prompt || widget.type;
        if (widget.type === 'input') return widget.properties?.label || '';
        return widget.properties?.label || '';
    }
};
