export const blackboardGeometryMethods = {
    normalizeLineAngle(angle) {
        const value = Number(angle);
        if (!Number.isFinite(value)) return 0;
        return ((value % 360) + 360) % 360;
    },

    getLineAngle(line = {}) {
        if (line.angle !== undefined && line.angle !== null) {
            return this.normalizeLineAngle(line.angle);
        }
        const x1 = Number(line.x1 ?? 0);
        const y1 = Number(line.y1 ?? 0);
        const x2 = Number(line.x2 ?? 1);
        const y2 = Number(line.y2 ?? 0);
        return this.normalizeLineAngle(Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI);
    },

    getLineEndpoints(width, height, angle) {
        const safeWidth = Math.max(1, Number(width) || 1);
        const safeHeight = Math.max(1, Number(height) || 1);
        const radians = this.normalizeLineAngle(angle) * Math.PI / 180;
        const dx = Math.cos(radians);
        const dy = Math.sin(radians);
        const cx = safeWidth / 2;
        const cy = safeHeight / 2;
        const tx = Math.abs(dx) > 0.0001 ? cx / Math.abs(dx) : Number.POSITIVE_INFINITY;
        const ty = Math.abs(dy) > 0.0001 ? cy / Math.abs(dy) : Number.POSITIVE_INFINITY;
        const length = Math.min(tx, ty);
        return {
            x1: cx - dx * length,
            y1: cy - dy * length,
            x2: cx + dx * length,
            y2: cy + dy * length
        };
    },

    getLineResizeState(widget, handle, event) {
        const geometry = widget.properties?.geometry || {};
        const line = widget.properties?.line || {};
        const width = Math.max(1, Number(geometry.width || 220) || 220);
        const height = Math.max(1, Number(geometry.height || 80) || 80);
        const endpoints = this.getLineEndpoints(width, height, this.getLineAngle(line));
        const start = {
            x: Number(line.x1 ?? endpoints.x1),
            y: Number(line.y1 ?? endpoints.y1)
        };
        const end = {
            x: Number(line.x2 ?? endpoints.x2),
            y: Number(line.y2 ?? endpoints.y2)
        };
        const originX = Number(geometry.x || 0);
        const originY = Number(geometry.y || 0);
        const moving = handle === 'line-start' ? start : end;
        const fixed = handle === 'line-start' ? end : start;
        return {
            fixedPoint: {
                x: originX + fixed.x,
                y: originY + fixed.y
            },
            movingPoint: {
                x: originX + moving.x,
                y: originY + moving.y
            },
            movingEndpoint: handle === 'line-start' ? 'start' : 'end',
            startX: event.clientX,
            startY: event.clientY
        };
    },

    getResizedGeometry(state, event) {
        const minWidth = Number(state.minWidth || 48);
        const minHeight = Number(state.minHeight || 32);
        const dx = event.clientX - state.startX;
        const dy = event.clientY - state.startY;
        const affectsWest = state.handle.includes('w');
        const affectsEast = state.handle.includes('e');
        const affectsNorth = state.handle.includes('n');
        const affectsSouth = state.handle.includes('s');
        let x = state.originX;
        let y = state.originY;
        let width = state.originWidth;
        let height = state.originHeight;
        if (affectsEast) {
            width = Math.max(minWidth, state.originWidth + dx);
        }
        if (affectsSouth) {
            height = Math.max(minHeight, state.originHeight + dy);
        }
        if (affectsWest) {
            width = Math.max(minWidth, state.originWidth - dx);
            x = state.originX + state.originWidth - width;
        }
        if (affectsNorth) {
            height = Math.max(minHeight, state.originHeight - dy);
            y = state.originY + state.originHeight - height;
        }
        return {x, y, width, height};
    },

    getLineEndpointResize(state, event) {
        const lineState = state.lineResize;
        const dx = event.clientX - lineState.startX;
        const dy = event.clientY - lineState.startY;
        const fixedPoint = lineState.fixedPoint;
        const movingPoint = {
            x: lineState.movingPoint.x + dx,
            y: lineState.movingPoint.y + dy
        };
        const minSize = 12;
        const minX = Math.min(fixedPoint.x, movingPoint.x);
        const minY = Math.min(fixedPoint.y, movingPoint.y);
        const maxX = Math.max(fixedPoint.x, movingPoint.x);
        const maxY = Math.max(fixedPoint.y, movingPoint.y);
        let x = minX;
        let y = minY;
        let width = maxX - minX;
        let height = maxY - minY;
        if (width < minSize) {
            x -= (minSize - width) / 2;
            width = minSize;
        }
        if (height < minSize) {
            y -= (minSize - height) / 2;
            height = minSize;
        }
        const fixedLocal = {
            x: fixedPoint.x - x,
            y: fixedPoint.y - y
        };
        const movingLocal = {
            x: movingPoint.x - x,
            y: movingPoint.y - y
        };
        const line = lineState.movingEndpoint === 'start'
            ? {x1: movingLocal.x, y1: movingLocal.y, x2: fixedLocal.x, y2: fixedLocal.y}
            : {x1: fixedLocal.x, y1: fixedLocal.y, x2: movingLocal.x, y2: movingLocal.y};
        line.angle = this.normalizeLineAngle(Math.atan2(line.y2 - line.y1, line.x2 - line.x1) * 180 / Math.PI);
        return {
            geometry: {x, y, width, height},
            line
        };
    },

    applyLineResizePreview(node, resize) {
        node.style.left = `${resize.geometry.x}px`;
        node.style.top = `${resize.geometry.y}px`;
        node.style.width = `${resize.geometry.width}px`;
        node.style.height = `${resize.geometry.height}px`;
        const svg = node.querySelector('.webmeet-blackboard-line-svg');
        const segment = svg?.querySelector?.('line');
        svg?.setAttribute('viewBox', `0 0 ${resize.geometry.width} ${resize.geometry.height}`);
        segment?.setAttribute('x1', String(resize.line.x1));
        segment?.setAttribute('y1', String(resize.line.y1));
        segment?.setAttribute('x2', String(resize.line.x2));
        segment?.setAttribute('y2', String(resize.line.y2));
        const startHandle = node.querySelector('[data-resize-handle="line-start"]');
        const endHandle = node.querySelector('[data-resize-handle="line-end"]');
        if (startHandle) {
            startHandle.style.left = `${resize.line.x1}px`;
            startHandle.style.top = `${resize.line.y1}px`;
        }
        if (endHandle) {
            endHandle.style.left = `${resize.line.x2}px`;
            endHandle.style.top = `${resize.line.y2}px`;
        }
    }
};
