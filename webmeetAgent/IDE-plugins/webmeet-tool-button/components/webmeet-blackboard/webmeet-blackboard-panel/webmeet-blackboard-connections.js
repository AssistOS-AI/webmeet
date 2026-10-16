const CONNECTION_ANCHORS = Object.freeze(['left', 'right', 'top', 'bottom']);
const CONNECTION_SNAP_DISTANCE = 18;
const CONNECTION_ANCHOR_RADIUS = 5;

function finiteGeometry(widget = {}, node = null) {
    const geometry = widget.properties?.geometry || {};
    const styleNumber = (name, fallback) => {
        const value = Number.parseFloat(node?.style?.[name]);
        return Number.isFinite(value) ? value : fallback;
    };
    const transformRotation = String(node?.style?.transform || '').match(/rotate\((-?[\d.]+)deg\)/);
    return {
        x: styleNumber('left', Number(geometry.x || 0)),
        y: styleNumber('top', Number(geometry.y || 0)),
        width: Math.max(1, styleNumber('width', Number(geometry.width || 1))),
        height: Math.max(1, styleNumber('height', Number(geometry.height || 1))),
        rotation: transformRotation ? Number(transformRotation[1]) : Number(widget.properties?.rotation ?? geometry.rotation ?? 0),
    };
}

function boundsForGeometries(geometries = []) {
    if (!geometries.length) return null;
    const x = Math.min(...geometries.map((geometry) => geometry.x));
    const y = Math.min(...geometries.map((geometry) => geometry.y));
    const right = Math.max(...geometries.map((geometry) => geometry.x + geometry.width));
    const bottom = Math.max(...geometries.map((geometry) => geometry.y + geometry.height));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y), rotation: 0};
}

function groupGeometryMembers(widgets = []) {
    return widgets.filter((widget) => !widget.properties?.connection);
}

function rotatePoint(point, center, degrees = 0) {
    const radians = Number(degrees || 0) * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    const dx = point.x - center.x;
    const dy = point.y - center.y;
    return {x: center.x + dx * cosine - dy * sine, y: center.y + dx * sine + dy * cosine};
}

function pointForAnchor(bounds, anchor = 'center') {
    const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    const points = {
        left: {x: bounds.x, y: center.y},
        right: {x: bounds.x + bounds.width, y: center.y},
        top: {x: center.x, y: bounds.y},
        bottom: {x: center.x, y: bounds.y + bounds.height},
        center,
    };
    return rotatePoint(points[String(anchor || 'center')] || center, center, bounds.rotation);
}

export function getConnectionAnchorIndicatorPoint(bounds, anchor) {
    const center = {x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2};
    const points = {
        left: {x: bounds.x - CONNECTION_ANCHOR_RADIUS, y: center.y},
        right: {x: bounds.x + bounds.width + CONNECTION_ANCHOR_RADIUS, y: center.y},
        top: {x: center.x, y: bounds.y - CONNECTION_ANCHOR_RADIUS},
        bottom: {x: center.x, y: bounds.y + bounds.height + CONNECTION_ANCHOR_RADIUS},
    };
    return rotatePoint(points[String(anchor || '')] || center, center, bounds.rotation);
}

export const blackboardConnectionMethods = {
    getConnectionTargetBounds(endpoint = {}) {
        const widgets = this.blackboard?.widgets || [];
        if (endpoint.widgetId) {
            const widget = widgets.find((entry) => String(entry.id) === String(endpoint.widgetId));
            if (!widget || widget.type === 'line') return null;
            return finiteGeometry(widget, this.widgetNodes?.get?.(widget.id));
        }
        if (endpoint.groupId) {
            const members = widgets.filter((widget) => String(widget.groupId || '') === String(endpoint.groupId));
            return boundsForGeometries(groupGeometryMembers(members)
                .map((widget) => finiteGeometry(widget, this.widgetNodes?.get?.(widget.id))));
        }
        return null;
    },

    resolveConnectionEndpoint(endpoint = null) {
        const bounds = endpoint ? this.getConnectionTargetBounds(endpoint) : null;
        return bounds ? pointForAnchor(bounds, endpoint.anchor) : null;
    },

    projectAttachedConnection(widget) {
        const connection = widget?.properties?.connection;
        if (widget?.type !== 'line' || !connection) return widget;
        const geometry = widget.properties?.geometry || {};
        const line = widget.properties?.line || {};
        const originX = Number(geometry.x || 0);
        const originY = Number(geometry.y || 0);
        const from = this.resolveConnectionEndpoint(connection.from) || {
            x: originX + Number(line.x1 ?? 0), y: originY + Number(line.y1 ?? Number(geometry.height || 1) / 2),
        };
        const to = this.resolveConnectionEndpoint(connection.to) || {
            x: originX + Number(line.x2 ?? Number(geometry.width || 1)), y: originY + Number(line.y2 ?? Number(geometry.height || 1) / 2),
        };
        const padding = 0.5;
        const x = Math.min(from.x, to.x) - padding;
        const y = Math.min(from.y, to.y) - padding;
        return {
            ...widget,
            properties: {
                ...widget.properties,
                geometry: {
                    ...geometry, x, y,
                    width: Math.max(1, Math.abs(to.x - from.x) + padding * 2),
                    height: Math.max(1, Math.abs(to.y - from.y) + padding * 2),
                    rotation: 0,
                },
                rotation: 0,
                line: {...line, x1: from.x - x, y1: from.y - y, x2: to.x - x, y2: to.y - y},
            },
        };
    },

    getConnectionTargets() {
        const widgets = this.blackboard?.widgets || [];
        const targets = [];
        const groups = new Set();
        for (const widget of widgets) {
            const groupId = String(widget.groupId || '');
            if (groupId) {
                if (!groups.has(groupId)) {
                    groups.add(groupId);
                    targets.push({groupId});
                }
            } else if (widget.type !== 'line') {
                targets.push({widgetId: String(widget.id)});
            }
        }
        return targets;
    },

    renderConnectionAnchors() {
        this.clearConnectionAnchors();
        const template = this.element?.querySelector?.('template[data-template="connection-anchor"]');
        if (!template?.content || !this.board) return;
        for (const target of this.getConnectionTargets()) {
            const bounds = this.getConnectionTargetBounds(target);
            if (!bounds) continue;
            for (const anchor of CONNECTION_ANCHORS) {
                const node = template.content.cloneNode(true).querySelector('.webmeet-blackboard-connection-anchor');
                if (!node) continue;
                const point = getConnectionAnchorIndicatorPoint(bounds, anchor);
                node.dataset.connectionAnchor = anchor;
                if (target.widgetId) node.dataset.connectionWidgetId = target.widgetId;
                if (target.groupId) node.dataset.connectionGroupId = target.groupId;
                node.style.left = `${point.x + 10}px`;
                node.style.top = `${point.y + 10}px`;
                this.board.append(node);
            }
        }
    },

    clearConnectionAnchors() {
        for (const node of this.board?.querySelectorAll?.('.webmeet-blackboard-connection-anchor') || []) node.remove();
        this.connectionSnapTarget = null;
    },

    findConnectionAnchorAtEvent(event) {
        let best = null;
        for (const node of this.board?.querySelectorAll?.('.webmeet-blackboard-connection-anchor') || []) {
            const rect = node.getBoundingClientRect();
            const dx = Number(event.clientX || 0) - (rect.left + rect.width / 2);
            const dy = Number(event.clientY || 0) - (rect.top + rect.height / 2);
            const distance = Math.hypot(dx, dy);
            if (distance > CONNECTION_SNAP_DISTANCE || (best && best.distance <= distance)) continue;
            const endpoint = {
                ...(node.dataset.connectionWidgetId ? {widgetId: node.dataset.connectionWidgetId} : {groupId: node.dataset.connectionGroupId}),
                anchor: node.dataset.connectionAnchor,
            };
            best = {node, endpoint, point: this.resolveConnectionEndpoint(endpoint), distance};
        }
        if (this.connectionSnapTarget?.node !== best?.node) {
            this.connectionSnapTarget?.node?.classList?.remove?.('is-snap-target');
            best?.node?.classList?.add?.('is-snap-target');
        }
        this.connectionSnapTarget = best;
        return best;
    },

    refreshConnectedLinePreviews() {
        for (const widget of this.blackboard?.widgets || []) {
            if (widget.type !== 'line' || !widget.properties?.connection) continue;
            const projected = this.projectAttachedConnection(widget);
            const node = this.widgetNodes?.get?.(widget.id);
            if (!node) continue;
            const geometry = projected.properties.geometry;
            const line = projected.properties.line;
            node.style.left = `${geometry.x}px`;
            node.style.top = `${geometry.y}px`;
            node.style.width = `${geometry.width}px`;
            node.style.height = `${geometry.height}px`;
            const svg = node.querySelector('.webmeet-blackboard-line-svg');
            svg?.setAttribute('viewBox', `0 0 ${geometry.width} ${geometry.height}`);
            for (const segment of svg?.querySelectorAll?.('.webmeet-blackboard-line-hit-target, .webmeet-blackboard-line-segment') || []) {
                segment.setAttribute('x1', String(line.x1));
                segment.setAttribute('y1', String(line.y1));
                segment.setAttribute('x2', String(line.x2));
                segment.setAttribute('y2', String(line.y2));
            }
            const start = node.querySelector('[data-resize-handle="line-start"]');
            const end = node.querySelector('[data-resize-handle="line-end"]');
            if (start) Object.assign(start.style, {left: `${line.x1}px`, top: `${line.y1}px`});
            if (end) Object.assign(end.style, {left: `${line.x2}px`, top: `${line.y2}px`});
        }
    },
};
