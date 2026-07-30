export const blackboardGraphicsRenderingMethods = {
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
        const label = String(widget.properties?.label || '').trim();
        if (label) {
            const text = this.createSvgElement('text');
            text.setAttribute('x', '50');
            text.setAttribute('y', '50');
            text.setAttribute('text-anchor', 'middle');
            text.setAttribute('dominant-baseline', 'middle');
            text.setAttribute('fill', String(style.textColor || defaults.textColor || '#172033'));
            text.setAttribute('font-size', String(Number(style.fontSize || 16) || 16));
            text.setAttribute('font-family', String(style.fontFamily || 'system-ui, sans-serif'));
            text.setAttribute('pointer-events', 'none');
            text.textContent = label;
            svg.append(text);
        }
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
        const strokeWidth = Number(style.strokeWidth || defaults.strokeWidth || 1) || 1;
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
        const applyCoordinates = (target) => {
            target.setAttribute('x1', String(x1));
            target.setAttribute('y1', String(y1));
            target.setAttribute('x2', String(x2));
            target.setAttribute('y2', String(y2));
        };
        const hitTarget = this.createSvgElement('line');
        hitTarget.setAttribute('class', 'webmeet-blackboard-line-hit-target');
        applyCoordinates(hitTarget);
        hitTarget.setAttribute('stroke', 'transparent');
        hitTarget.setAttribute('stroke-width', String(Math.max(12, strokeWidth)));
        hitTarget.setAttribute('stroke-linecap', 'round');
        hitTarget.setAttribute('pointer-events', 'stroke');
        svg.append(hitTarget);

        const segment = this.createSvgElement('line');
        segment.setAttribute('class', 'webmeet-blackboard-line-segment');
        applyCoordinates(segment);
        segment.setAttribute('stroke', stroke);
        segment.setAttribute('stroke-width', String(strokeWidth));
        segment.setAttribute('stroke-linecap', 'round');
        if (markerStart === 'arrow') {
            segment.setAttribute('marker-start', `url(#${markerIdBase})`);
        }
        if (markerEnd === 'arrow') {
            segment.setAttribute('marker-end', `url(#${markerIdBase})`);
        }
        segment.setAttribute('pointer-events', 'none');
        svg.append(segment);
        return svg;
    },
};
