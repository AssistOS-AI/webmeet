import { cloneJson } from './model.mjs';
import { getCanonicalWidgetCapabilities } from './event-contract.mjs';

export const EMPTY_BLACKBOARD_BOUNDS = Object.freeze({
    x: 0,
    y: 0,
    width: 1200,
    height: 800,
    centerX: 600,
    centerY: 400,
});
export const DEFAULT_LAYOUT_GAP = 40;

export function calculateLineFromCenter({ centerX = 0, centerY = 0, length = 0, angle = 0 } = {}) {
    const radians = Number(angle || 0) * Math.PI / 180;
    const half = Math.max(0, Number(length || 0)) / 2;
    const dx = Math.cos(radians) * half;
    const dy = Math.sin(radians) * half;
    return {
        x1: Number(centerX || 0) - dx,
        y1: Number(centerY || 0) - dy,
        x2: Number(centerX || 0) + dx,
        y2: Number(centerY || 0) + dy,
    };
}

export function getWidgetCapabilities(widget = {}) {
    return getCanonicalWidgetCapabilities(widget.type) || {
        movable: false, resizable: false, deletable: false, groupable: false, editableProperties: [], domainActions: [],
    };
}

function getAbsoluteFreeLine(widget = {}) {
    if (String(widget?.type || '') !== 'line' || widget?.properties?.connection) return null;
    const geometry = widget?.properties?.geometry || {};
    const line = widget?.properties?.line;
    if (line) {
        const coordinates = [line.x1, line.y1, line.x2, line.y2].map(Number);
        if (!coordinates.every(Number.isFinite)) return null;
        const originX = Number(geometry.x || 0);
        const originY = Number(geometry.y || 0);
        return {
            x1: originX + coordinates[0], y1: originY + coordinates[1],
            x2: originX + coordinates[2], y2: originY + coordinates[3],
            ...(line.markerStart ? { markerStart: String(line.markerStart) } : {}),
            ...(line.markerEnd ? { markerEnd: String(line.markerEnd) } : {}),
        };
    }
    const embedded = [geometry.x1, geometry.y1, geometry.x2, geometry.y2].map(Number);
    return embedded.every(Number.isFinite)
        ? { x1: embedded[0], y1: embedded[1], x2: embedded[2], y2: embedded[3] }
        : null;
}

function getScriptaSemanticState(widget = {}) {
    if (String(widget?.type || '') !== 'scripta-document') return null;
    const properties = widget?.properties || {};
    const chapters = (Array.isArray(properties.chapters) ? properties.chapters : []).map((chapter, chapterIndex) => ({
        chapterId: String(chapter?.chapterId || ''),
        ordinal: Math.max(1, Number(chapter?.chapterOrdinal || chapterIndex + 1)),
        title: String(chapter?.chapterTitle || ''),
        paragraphs: (Array.isArray(chapter?.paragraphs) ? chapter.paragraphs : []).map((paragraph, paragraphIndex) => ({
            paragraphId: String(paragraph?.paragraphId || ''),
            ordinal: Math.max(1, Number(paragraph?.paragraphOrdinal || paragraphIndex + 1)),
        })),
    }));
    const focusedParagraphId = String(properties.focusedParagraphId || '');
    const focusedChapterId = String(properties.focusedChapterId || '')
        || chapters.find((chapter) => chapter.paragraphs.some((paragraph) => paragraph.paragraphId === focusedParagraphId))?.chapterId
        || '';
    const focusedChapter = chapters.find((chapter) => chapter.chapterId === focusedChapterId) || null;
    const focusedParagraph = focusedChapter?.paragraphs.find((paragraph) => paragraph.paragraphId === focusedParagraphId) || null;
    const paragraphProjection = properties.paragraph && typeof properties.paragraph === 'object'
        ? properties.paragraph
        : null;
    const variants = (Array.isArray(paragraphProjection?.variants) ? paragraphProjection.variants : []).map((variant, variantIndex) => ({
        variantId: String(variant?.id || ''),
        ordinal: variantIndex + 1,
        text: String(variant?.text || ''),
        images: (Array.isArray(variant?.images) ? variant.images : []).map((image, imageIndex) => ({
            ordinal: Math.max(1, Number(image?.ordinal || imageIndex + 1)),
            alt: String(image?.alt || 'Image'),
            position: Math.max(0, Number(image?.position || 0)),
            layout: cloneJson(image?.layout || null),
        })),
    }));
    const selectedVariantId = String(paragraphProjection?.selectedVariantId || paragraphProjection?.activeVariantId || '');
    const selectedVariantOrdinal = variants.findIndex((variant) => variant.variantId === selectedVariantId) + 1;
    return {
        activeResourceId: String(properties.resourceId || ''),
        documentTitle: String(properties.documentTitle || ''),
        view: {
            mode: String(properties.viewMode || 'document'),
            focusTargetType: String(properties.focusTargetType || ''),
            chapterId: focusedChapterId,
            chapterOrdinal: focusedChapter?.ordinal || null,
            paragraphId: focusedParagraphId,
            paragraphOrdinal: focusedParagraph?.ordinal || null,
            ...(paragraphProjection ? {
                selectedVariantId,
                selectedVariantOrdinal: selectedVariantOrdinal || null,
            } : {}),
        },
        documentOutline: chapters,
        ...(paragraphProjection ? { paragraph: {
            chapterId: String(paragraphProjection.chapterId || focusedChapterId),
            chapterOrdinal: Number(paragraphProjection.chapterOrdinal || focusedChapter?.ordinal || 0) || null,
            paragraphId: String(paragraphProjection.paragraphId || focusedParagraphId),
            paragraphOrdinal: Number(paragraphProjection.paragraphOrdinal || focusedParagraph?.ordinal || 0) || null,
            variants,
        } } : {}),
    };
}

export function calculateContentBounds(widgets = []) {
    const boxes = (Array.isArray(widgets) ? widgets : []).filter((widget) => {
        const mode = String(widget?.visibility?.mode || widget?.visibility || 'all');
        return mode !== 'hidden' && (widget?.properties?.geometry || widget?.properties?.line);
    }).map((widget) => {
        const absoluteLine = getAbsoluteFreeLine(widget);
        if (absoluteLine) {
            return {
                x: Math.min(absoluteLine.x1, absoluteLine.x2),
                y: Math.min(absoluteLine.y1, absoluteLine.y2),
                right: Math.max(absoluteLine.x1, absoluteLine.x2),
                bottom: Math.max(absoluteLine.y1, absoluteLine.y2),
            };
        }
        const geometry = widget.properties.geometry;
        if (!geometry && widget.properties?.line) {
            const line = widget.properties.line;
            const x1 = Number(line.x1 || 0);
            const y1 = Number(line.y1 || 0);
            const x2 = Number(line.x2 || 0);
            const y2 = Number(line.y2 || 0);
            return { x: Math.min(x1, x2), y: Math.min(y1, y2), right: Math.max(x1, x2), bottom: Math.max(y1, y2) };
        }
        const x = Number(geometry.x || 0);
        const y = Number(geometry.y || 0);
        return { x, y, right: x + Math.max(0, Number(geometry.width || 0)), bottom: y + Math.max(0, Number(geometry.height || 0)) };
    });
    if (!boxes.length) return { ...EMPTY_BLACKBOARD_BOUNDS };
    const x = Math.min(...boxes.map((box) => box.x));
    const y = Math.min(...boxes.map((box) => box.y));
    const right = Math.max(...boxes.map((box) => box.right));
    const bottom = Math.max(...boxes.map((box) => box.bottom));
    const width = right - x;
    const height = bottom - y;
    return { x, y, width, height, centerX: x + width / 2, centerY: y + height / 2 };
}

export function buildSemanticBoardContext(board = {}) {
    const boardWidgets = Array.isArray(board.widgets) ? board.widgets : [];
    const groupOrdinals = new Map();
    let nextOrdinal = 0;
    const widgets = boardWidgets.map((widget) => {
        const groupId = String(widget.groupId || '');
        if (groupId && !groupOrdinals.has(groupId)) groupOrdinals.set(groupId, ++nextOrdinal);
        const ordinal = groupId ? groupOrdinals.get(groupId) : ++nextOrdinal;
        const scripta = getScriptaSemanticState(widget);
        return {
            ordinal,
            targetType: groupId ? 'group' : 'widget',
            id: String(widget.id || ''),
            type: String(widget.type || ''),
            label: String(widget.properties?.label || ''),
            text: String(widget.properties?.text || ''),
            geometry: cloneJson(widget.properties?.geometry || null),
            rotation: Number(widget.properties?.rotation ?? widget.properties?.geometry?.rotation ?? 0),
            line: cloneJson(getAbsoluteFreeLine(widget)),
            style: cloneJson(widget.properties?.style || null),
            groupId,
            connection: cloneJson(widget.properties?.connection || null),
            capabilities: getWidgetCapabilities(widget),
            ...(scripta ? { scripta: cloneJson(scripta) } : {}),
        };
    });
    const groups = [...groupOrdinals.entries()].map(([groupId, ordinal]) => {
        const members = widgets.filter((widget) => widget.groupId === groupId);
        return {
            ordinal,
            groupId,
            geometry: calculateContentBounds(boardWidgets.filter((widget) => String(widget.groupId || '') === groupId)),
            memberWidgetIds: members.map((widget) => widget.id),
            members: members.map((widget) => ({
                id: widget.id,
                type: widget.type,
                label: widget.label,
            })),
            capabilities: {
                movable: true,
                resizable: true,
                rotatable: true,
                deletable: true,
                ungroupable: true,
            },
        };
    });
    const focusedWidgetId = String(board.interactionContext?.focusedWidgetId || '');
    const focusedGroupId = String(
        widgets.find((widget) => widget.id === focusedWidgetId)?.groupId || ''
    );
    return {
        contentBounds: calculateContentBounds(board.widgets),
        focusedWidgetId: focusedGroupId ? '' : focusedWidgetId,
        focusedGroupId,
        lastAffectedWidgetIds: cloneJson(board.interactionContext?.lastAffectedWidgetIds || []),
        groups,
        widgets,
    };
}
