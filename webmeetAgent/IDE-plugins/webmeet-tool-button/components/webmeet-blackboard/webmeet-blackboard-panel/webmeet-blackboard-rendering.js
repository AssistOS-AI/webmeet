import { TEXT_DEFAULT_STYLE } from './webmeet-blackboard-text-style.js';

export const blackboardRenderingMethods = {
    renderWidgets() {
        if (!this.board) return;
        if (this.inlineEditWidgetId) {
            this.pendingRenderAfterInlineEdit = true;
            this.updateToolbarState();
            return;
        }
        this.pendingRenderAfterInlineEdit = false;
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
        node.tabIndex = 0;
        node.setAttribute('aria-selected', String(this.selection === widget.id));
        node.style.left = `${Number(geometry.x || 0)}px`;
        node.style.top = `${Number(geometry.y || 0)}px`;
        const widgetWidth = Number(geometry.width || 120);
        const widgetHeight = Number(geometry.height || 64);
        const minPollWidth = widget.type === 'poll' ? 260 : 1;
        const minPollHeight = widget.type === 'poll' ? 132 : 1;
        const minBulletsWidth = widget.type === 'bullets' ? 320 : 1;
        const minBulletsHeight = widget.type === 'bullets' ? 190 : 1;
        node.style.width = `${Math.max(widgetWidth, minPollWidth, minBulletsWidth)}px`;
        node.style.height = `${Math.max(widgetHeight, minPollHeight, minBulletsHeight)}px`;
        const rotation = this.getWidgetRotation(widget);
        node.style.transform = rotation ? `rotate(${rotation}deg)` : '';
        node.style.transformOrigin = 'center center';
        node.style.setProperty('--widget-rotation', `${rotation}deg`);
        node.style.setProperty('--widget-counter-rotation', `${-rotation}deg`);
        const themeDefaults = this.getBlackboardTheme().defaults || {};
        const typeDefaults = themeDefaults[widget.type] || themeDefaults.shape || {};
        const textDefaults = themeDefaults.text || {};
        node.style.setProperty('--fill', style.fill || typeDefaults.fill || 'var(--bb-widget-bg)');
        node.style.setProperty('--stroke', style.stroke || typeDefaults.stroke || 'var(--bb-widget-border)');
        const cssStrokeWidth = Number(style.strokeWidth ?? typeDefaults.strokeWidth ?? 1) || 0;
        node.style.setProperty('--stroke-width', `${cssStrokeWidth}px`);
        node.style.setProperty('--text-color', style.textColor || textDefaults.textColor || 'var(--bb-widget-text)');
        this.renderWidgetContent(node, widget);
        this.renderResizeHandles(node, widget);
        this.renderContextMenu(node, widget);
        if (this.canMoveWidget(widget)) {
            node.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        }
        node.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!this.canEditWidget(widget)) return;
            this.selection = widget.id;
            void this.editWidget(widget);
        });
        return node;
    },

    renderContextMenu(node, widget) {
        if (!widget?.id || widget.locked) return;
        if (!this.canEditWidget(widget) && !this.canMoveWidget(widget)) return;
        const menu = document.createElement('div');
        menu.className = 'webmeet-blackboard-context-menu';
        menu.setAttribute('aria-label', 'Widget actions');
        menu.addEventListener('pointerdown', (event) => event.stopPropagation());

        const moveHandle = this.createContextButton('move', 'Move widget', 'Move', 'move');
        moveHandle.addEventListener('pointerdown', (event) => this.beginLocalDrag(event, widget));
        menu.append(moveHandle);

        if (this.canEditWidget(widget)) {
            const settingsButton = this.createContextButton('settings', 'Widget settings', 'Widget settings', 'settings');
            settingsButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.selection = widget.id;
                void this.editWidget(widget);
            });
            menu.append(settingsButton);
        }

        if (this.canRotateWidget(widget)) {
            const rotateHandle = this.createContextButton('rotate', 'Rotate widget', 'Rotate', 'rotate');
            rotateHandle.addEventListener('pointerdown', (event) => this.beginLocalRotate(event, widget));
            menu.append(rotateHandle);
        }

        if (this.canEditWidget(widget)) {
            const deleteButton = this.createContextButton('delete', 'Delete widget', 'Delete', 'delete');
            deleteButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.selection = widget.id;
                void this.deleteSelectedWidget();
            });
            menu.append(deleteButton);
        }
        node.append(menu);
    },

    createContextButton(action, title, ariaLabel, icon) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `webmeet-blackboard-context-button ${action}`;
        button.dataset.contextAction = action;
        button.title = title;
        button.setAttribute('aria-label', ariaLabel);
        button.append(this.createContextIcon(icon));
        return button;
    },

    createContextIcon(icon) {
        const span = document.createElement('span');
        span.className = `webmeet-blackboard-context-icon ${icon}`;
        span.setAttribute('aria-hidden', 'true');
        return span;
    },

    canResizeWidget(widget) {
        if (!widget || widget.locked) return false;
        if (widget.type === 'poll' && !this.canEditWidget(widget)) return false;
        const widgetType = String(widget.type || 'shape').trim() || 'shape';
        return ['shape', 'line', 'card', 'text', 'image', 'bullets'].includes(widgetType);
    },

    canEditWidget(widget) {
        if (!widget) return false;
        if (widget.type !== 'poll') return true;
        return widget.properties?.canManagePoll === true;
    },

    canMoveWidget(widget) {
        if (!widget || widget.locked) return false;
        if (widget.type === 'poll') return this.canEditWidget(widget);
        return true;
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
        if (widget.type === 'image') {
            const frame = document.createElement('div');
            frame.className = 'webmeet-blackboard-image-frame';
            const image = document.createElement('img');
            const source = widget.properties?.source || {};
            image.className = 'webmeet-blackboard-image';
            image.alt = String(widget.properties?.alt || source.name || 'Image');
            image.draggable = false;
            image.src = String(source.url || source.downloadUrl || widget.properties?.src || '');
            frame.append(image);
            node.append(frame);
            return;
        }
        if (widget.type === 'poll') {
            this.renderPollWidgetContent(node, widget);
            return;
        }
        if (widget.type === 'bullets') {
            this.renderBulletsWidgetContent(node, widget);
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
            this.applyTextStyleToNode(text, widget.properties?.style || {});
            node.append(text);
            return;
        }
        node.textContent = this.getWidgetLabel(widget);
    },

    applyTextStyleToNode(node, style = {}) {
        const normalized = this.normalizeTextStyle(style, false);
        const theme = this.getBlackboardTheme();
        const textDefaults = theme.defaults?.text || {};
        node.style.fontFamily = String(normalized.fontFamily || TEXT_DEFAULT_STYLE.fontFamily);
        node.style.fontSize = `${Number(normalized.fontSize || TEXT_DEFAULT_STYLE.fontSize)}px`;
        node.style.fontWeight = String(normalized.fontWeight || TEXT_DEFAULT_STYLE.fontWeight);
        node.style.fontStyle = String(normalized.fontStyle || TEXT_DEFAULT_STYLE.fontStyle);
        node.style.color = String(normalized.textColor || textDefaults.textColor || theme.tokens?.widgetText || TEXT_DEFAULT_STYLE.textColor);
    },

    createSvgElement(tagName) {
        return document.createElementNS('http://www.w3.org/2000/svg', tagName);
    },

    createShapeSvg(widget) {
        const shapeKind = String(widget.properties?.shapeKind || 'rectangle').trim() || 'rectangle';
        const style = widget.properties?.style || {};
        const defaults = this.getBlackboardTheme().defaults?.shape || {};
        const fill = style.fill || defaults.fill || '#ffffff';
        const stroke = style.stroke || defaults.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || defaults.strokeWidth || 2) || 2;
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
        const defaults = this.getBlackboardTheme().defaults?.line || {};
        const stroke = style.stroke || defaults.stroke || '#334155';
        const strokeWidth = Number(style.strokeWidth || defaults.strokeWidth || 3) || 3;
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

    renderPollWidgetContent(node, widget) {
        const props = widget.properties || {};
        const currentPoll = this.getCurrentPollValue(widget);
        const canManagePoll = props.canManagePoll === true;
        const statusValue = this.getPollStatus(widget);
        const hasPolld = Boolean(currentPoll);
        const questions = this.getPollQuestions(widget);

        const summary = document.createElement('button');
        summary.type = 'button';
        summary.className = 'webmeet-blackboard-poll-summary subtle-button';
        summary.addEventListener('pointerdown', (event) => event.stopPropagation());
        summary.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (statusValue === 'closed') {
                void this.openPollResultsModal(widget);
                return;
            }
            void this.openPollModal(widget);
        });

        const title = document.createElement('span');
        title.className = 'webmeet-blackboard-widget-title';
        title.textContent = props.description || 'Poll';

        const status = document.createElement('div');
        status.className = 'webmeet-blackboard-poll-status';
        status.textContent = this.getPollStatusText(widget, currentPoll);

        const meta = document.createElement('span');
        meta.className = 'webmeet-blackboard-poll-meta';
        meta.textContent = `${questions.length} question${questions.length === 1 ? '' : 's'}${hasPolld ? ' • polld' : ''}`;

        const adminActions = this.createPollAdminActions(widget, statusValue, canManagePoll);
        summary.append(title, status, meta);
        node.append(summary);
        if (adminActions) node.append(adminActions);
    },

    renderBulletsWidgetContent(node, widget) {
        const props = widget.properties || {};
        const items = Array.isArray(props.items) ? props.items : [];
        const visibleItems = items.slice(0, 5);

        const header = document.createElement('div');
        header.className = 'webmeet-blackboard-bullets-header';
        const title = document.createElement('div');
        title.className = 'webmeet-blackboard-bullets-title';
        title.textContent = String(props.title || 'Meeting Bullets').trim() || 'Meeting Bullets';
        const meta = document.createElement('div');
        meta.className = 'webmeet-blackboard-bullets-meta';
        const dateText = String(props.meetingDateTime || '').trim();
        const participantCount = Number.parseInt(String(props.participantCount || 0), 10) || 0;
        meta.textContent = [dateText, participantCount > 0 ? `${participantCount} participants` : '']
            .filter(Boolean)
            .join(' • ');
        header.append(title, meta);

        const list = document.createElement('div');
        list.className = 'webmeet-blackboard-bullets-list';
        if (visibleItems.length) {
            for (const item of visibleItems) {
                list.append(this.createBulletsItemRow(item));
            }
        } else {
            const empty = document.createElement('div');
            empty.className = 'webmeet-blackboard-bullets-empty';
            empty.textContent = 'No notes yet';
            list.append(empty);
        }

        const footer = document.createElement('div');
        footer.className = 'webmeet-blackboard-bullets-footer';
        const addButton = document.createElement('button');
        addButton.type = 'button';
        addButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
        addButton.textContent = 'Add Note';
        addButton.addEventListener('pointerdown', (event) => event.stopPropagation());
        addButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.addBulletsNote(widget);
        });
        const viewButton = document.createElement('button');
        viewButton.type = 'button';
        viewButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
        viewButton.textContent = items.length > visibleItems.length ? `View Full Notes (+${items.length - visibleItems.length})` : 'View Full Notes';
        viewButton.addEventListener('pointerdown', (event) => event.stopPropagation());
        viewButton.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.editWidget(widget);
        });
        footer.append(addButton, viewButton);
        node.append(header, list, footer);
    },

    createBulletsItemRow(item = {}) {
        const row = document.createElement('div');
        const status = this.normalizeBulletsStatus(item.status);
        const priority = this.normalizeBulletsPriority(item.priority);
        row.className = `webmeet-blackboard-bullets-item status-${status} priority-${priority}`;

        const icon = document.createElement('span');
        icon.className = 'webmeet-blackboard-bullets-status-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = this.getBulletsStatusIcon(status);

        const text = document.createElement('span');
        text.className = 'webmeet-blackboard-bullets-text';
        text.textContent = String(item.text || '').trim();

        const badge = document.createElement('span');
        badge.className = `webmeet-blackboard-bullets-priority priority-${priority}`;
        badge.textContent = this.getBulletsPriorityLabel(priority);

        row.append(icon, text, badge);
        return row;
    },

    normalizeBulletsStatus(status = '') {
        const normalized = String(status || '').trim();
        return ['todo', 'inProgress', 'done', 'blocked'].includes(normalized) ? normalized : 'todo';
    },

    normalizeBulletsPriority(priority = '') {
        const normalized = String(priority || '').trim();
        return ['high', 'medium', 'low'].includes(normalized) ? normalized : 'medium';
    },

    getBulletsStatusIcon(status = 'todo') {
        if (status === 'inProgress') return '↯';
        if (status === 'done') return '✓';
        if (status === 'blocked') return '!';
        return '○';
    },

    getBulletsPriorityLabel(priority = 'medium') {
        if (priority === 'high') return '▲ High';
        if (priority === 'low') return '▼ Low';
        return 'Medium';
    },

    getPollQuestions(widget) {
        return Array.isArray(widget.properties?.questions) ? widget.properties.questions : [];
    },

    getPollStatus(widget) {
        const props = widget.properties || {};
        const status = String(props.status || 'open').trim();
        if (status === 'closed') return 'closed';
        if (props.closesAt && Date.now() >= Date.parse(String(props.closesAt))) return 'closed';
        if (status === 'draft') return 'draft';
        return 'open';
    },

    getPollStatusText(widget, currentPoll = '') {
        const props = widget.properties || {};
        const status = this.getPollStatus(widget);
        if (status === 'draft') return 'Poll has not started';
        if (status === 'closed') return currentPoll ? `Closed. Your poll: ${currentPoll}` : 'Poll closed';
        const closesAt = String(props.closesAt || '').trim();
        if (closesAt) {
            const secondsLeft = Math.max(0, Math.ceil((Date.parse(closesAt) - Date.now()) / 1000));
            return currentPoll ? `Your poll: ${currentPoll}. Closes in ${secondsLeft}s` : `Open. Closes in ${secondsLeft}s`;
        }
        return currentPoll ? `Your poll: ${currentPoll}` : 'No poll submitted';
    },

    createPollAdminActions(widget, statusValue, canManagePoll) {
        if (!canManagePoll) return null;
        const actions = document.createElement('div');
        actions.className = 'webmeet-blackboard-poll-admin-actions';
        if (statusValue === 'draft') {
            const startButton = document.createElement('button');
            startButton.type = 'button';
            startButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            startButton.textContent = 'Start';
            startButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            startButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.startPollWidget(widget);
            });
            actions.append(startButton);
        }
        if (statusValue === 'open') {
            const closeButton = document.createElement('button');
            closeButton.type = 'button';
            closeButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            closeButton.textContent = 'Close';
            closeButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            closeButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.closePollWidget(widget);
            });
            actions.append(closeButton);
        }
        if (statusValue === 'closed') {
            const resultsButton = document.createElement('button');
            resultsButton.type = 'button';
            resultsButton.className = 'subtle-button webmeet-blackboard-widget-action-button';
            resultsButton.textContent = 'Results';
            resultsButton.addEventListener('pointerdown', (event) => event.stopPropagation());
            resultsButton.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.openPollResultsModal(widget);
            });
            actions.append(resultsButton);
        }
        return actions.children.length ? actions : null;
    },

    getCurrentPollValue(widget) {
        const participantData = widget.properties?.participantData || {};
        const participantId = String(this.adapter?.participantId || '').trim();
        if (participantId && participantData[participantId]?.answers) {
            return Object.values(participantData[participantId].answers || {}).filter(Boolean).join(', ');
        }
        return '';
    },

    getWidgetLabel(widget) {
        if (widget.type === 'text') return widget.properties?.text || '';
        if (widget.type === 'poll') return widget.properties?.description || widget.type;
        if (widget.type === 'bullets') return widget.properties?.title || widget.type;
        return widget.properties?.label || '';
    }
};
