import html2canvas from '../vendor/html2canvas/html2canvas.esm.js';

const EXPORT_PADDING = 16;
const EXPORT_SCALE = 2;
const MAX_EXPORT_SIDE = 8192;
const MAX_EXPORT_PIXELS = 32_000_000;

export const GROUP_EXPORT_EXCLUDED_SELECTOR = [
    '.webmeet-blackboard-context-menu',
    '.webmeet-blackboard-resize-handle',
    '.webmeet-blackboard-widget-ordinal',
    '.webmeet-blackboard-bullets-fullscreen-button',
    '.webmeet-blackboard-widget-action-button',
    '.webmeet-blackboard-poll-admin-actions',
    '.webmeet-scripta-inline-actions',
    '.webmeet-scripta-chapter-actions',
    '.webmeet-scripta-paragraph-actions',
    '.webmeet-scripta-header-action',
    '.webmeet-scripta-chapter-title-edit',
    '.webmeet-scripta-paragraph-nav',
].join(',');

function finite(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

let colorProbeContext = null;

function normalizeModernCssColors(value) {
    const source = String(value || '');
    if (!/\b(?:color|oklab|oklch|lab|lch)\(/i.test(source) || source.includes('url(')) return source;
    colorProbeContext ||= document.createElement('canvas').getContext('2d', {willReadFrequently: true});
    if (!colorProbeContext) return source;
    return source.replace(/\b(?:color|oklab|oklch|lab|lch)\([^()]*\)/gi, (color) => {
        colorProbeContext.clearRect(0, 0, 1, 1);
        colorProbeContext.fillStyle = 'rgba(0, 0, 0, 0)';
        colorProbeContext.fillStyle = color;
        colorProbeContext.fillRect(0, 0, 1, 1);
        const [red, green, blue, alpha] = colorProbeContext.getImageData(0, 0, 1, 1).data;
        return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    });
}

function rootMetrics(node, widget = {}) {
    const geometry = widget.properties?.geometry || {};
    const x = finite(parseFloat(node?.style?.left), finite(geometry.x));
    const y = finite(parseFloat(node?.style?.top), finite(geometry.y));
    const width = Math.max(1, finite(node?.offsetWidth, finite(parseFloat(node?.style?.width), finite(geometry.width, 1))));
    const height = Math.max(1, finite(node?.offsetHeight, finite(parseFloat(node?.style?.height), finite(geometry.height, 1))));
    const rotation = finite(widget.properties?.rotation ?? geometry.rotation);
    return {x, y, width, height, rotation};
}

export function calculateRotatedBounds(items = []) {
    const points = [];
    for (const item of items) {
        const x = finite(item.x);
        const y = finite(item.y);
        const width = Math.max(1, finite(item.width, 1));
        const height = Math.max(1, finite(item.height, 1));
        const radians = finite(item.rotation) * Math.PI / 180;
        const centerX = x + width / 2;
        const centerY = y + height / 2;
        for (const [cornerX, cornerY] of [[x, y], [x + width, y], [x + width, y + height], [x, y + height]]) {
            const dx = cornerX - centerX;
            const dy = cornerY - centerY;
            points.push({
                x: centerX + dx * Math.cos(radians) - dy * Math.sin(radians),
                y: centerY + dx * Math.sin(radians) + dy * Math.cos(radians),
            });
        }
    }
    if (!points.length) return null;
    const x = Math.min(...points.map((point) => point.x));
    const y = Math.min(...points.map((point) => point.y));
    const right = Math.max(...points.map((point) => point.x));
    const bottom = Math.max(...points.map((point) => point.y));
    return {x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y)};
}

export function calculatePngScale(width, height) {
    const logicalWidth = Math.max(1, finite(width, 1));
    const logicalHeight = Math.max(1, finite(height, 1));
    return Math.min(
        EXPORT_SCALE,
        MAX_EXPORT_SIDE / logicalWidth,
        MAX_EXPORT_SIDE / logicalHeight,
        Math.sqrt(MAX_EXPORT_PIXELS / (logicalWidth * logicalHeight)),
    );
}

export function selectGroupExportWidgets(widgets = [], groupId = '') {
    const normalizedGroupId = String(groupId || '').trim();
    if (!normalizedGroupId) return [];
    const members = widgets.filter((widget) => String(widget.groupId || '') === normalizedGroupId);
    const memberIds = new Set(members.map((widget) => String(widget.id)));
    return widgets.filter((widget) => {
        if (memberIds.has(String(widget.id))) return true;
        const connection = widget.type === 'line' ? widget.properties?.connection : null;
        return connection
            && memberIds.has(String(connection.from?.widgetId || ''))
            && memberIds.has(String(connection.to?.widgetId || ''));
    });
}

export function groupExportFilename(background, date = new Date()) {
    const suffix = background === 'board' ? 'board' : 'transparent';
    const timestamp = date.toISOString().replace(/[:.]/g, '-');
    return `webmeet-group-${timestamp}-${suffix}.png`;
}

function copyComputedStyles(source, clone) {
    const computed = getComputedStyle(source);
    for (let index = 0; index < computed.length; index += 1) {
        const property = computed.item(index);
        clone.style.setProperty(
            property,
            normalizeModernCssColors(computed.getPropertyValue(property)),
            computed.getPropertyPriority(property),
        );
    }
    clone.style.setProperty('animation', 'none');
    clone.style.setProperty('transition', 'none');
    clone.style.setProperty('caret-color', 'transparent');
    clone.style.setProperty('pointer-events', 'none');
}

function cloneVisibleTree(source, imagePairs) {
    if (source.nodeType === Node.TEXT_NODE) return source.cloneNode();
    if (source.nodeType !== Node.ELEMENT_NODE || source.matches?.(GROUP_EXPORT_EXCLUDED_SELECTOR)) return null;
    const shadowRoot = source.shadowRoot?.mode === 'open' ? source.shadowRoot : null;
    const clone = shadowRoot ? document.createElement('div') : source.cloneNode(false);
    copyComputedStyles(source, clone);
    if (source instanceof HTMLInputElement) {
        clone.setAttribute('value', source.value);
        if (source.checked) clone.setAttribute('checked', '');
        else clone.removeAttribute('checked');
    } else if (source instanceof HTMLTextAreaElement) {
        clone.textContent = source.value;
    } else if (source instanceof HTMLImageElement) {
        imagePairs.push({source, clone});
    }
    const renderedChildren = source instanceof HTMLSlotElement
        ? source.assignedNodes({flatten: true})
        : shadowRoot?.childNodes || source.childNodes;
    for (const child of renderedChildren) {
        const childClone = cloneVisibleTree(child, imagePairs);
        if (childClone) clone.append(childClone);
    }
    if (source instanceof HTMLSelectElement) {
        for (const [index, option] of [...clone.options].entries()) {
            if (source.options[index]?.selected) option.setAttribute('selected', '');
            else option.removeAttribute('selected');
        }
    }
    if ((source.scrollLeft || source.scrollTop) && clone.firstElementChild) {
        clone.style.overflow = 'hidden';
        for (const child of clone.children) {
            const transform = child.style.transform === 'none' ? '' : child.style.transform;
            child.style.transform = `translate(${-source.scrollLeft}px, ${-source.scrollTop}px) ${transform}`.trim();
            child.style.transformOrigin = 'top left';
        }
    }
    return clone;
}

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.addEventListener('load', () => resolve(String(reader.result || '')));
        reader.addEventListener('error', () => reject(reader.error || new Error('The image could not be read.')));
        reader.readAsDataURL(blob);
    });
}

function isEmbeddedResourceUrl(url) {
    const normalized = String(url || '').trim();
    return !normalized || normalized.startsWith('data:') || normalized.startsWith('#');
}

export function externalCssResourceUrls(value) {
    const expression = /url\(\s*(["']?)(.*?)\1\s*\)/g;
    return [...String(value || '').matchAll(expression)]
        .map((match) => String(match[2] || '').trim())
        .filter((url) => !isEmbeddedResourceUrl(url));
}

async function resourceToDataUrl(url, cache) {
    const absoluteUrl = new URL(String(url), document.baseURI).href;
    if (!cache.has(absoluteUrl)) {
        cache.set(absoluteUrl, (async () => {
            let response;
            try {
                response = await fetch(absoluteUrl, {credentials: 'same-origin'});
            } catch (error) {
                throw new Error(`The group could not be exported because a visual resource could not be loaded: ${error.message}`);
            }
            if (!response.ok) {
                throw new Error(`The group could not be exported because a visual resource returned HTTP ${response.status}.`);
            }
            return blobToDataUrl(await response.blob());
        })());
    }
    return cache.get(absoluteUrl);
}

async function inlineCssValue(value, cache) {
    if (!String(value).includes('url(')) return value;
    const expression = /url\(\s*(["']?)(.*?)\1\s*\)/g;
    const matches = [...String(value).matchAll(expression)];
    if (!matches.length) return value;
    let result = '';
    let cursor = 0;
    for (const match of matches) {
        result += String(value).slice(cursor, match.index);
        const resourceUrl = String(match[2] || '').trim();
        if (isEmbeddedResourceUrl(resourceUrl)) result += match[0];
        else result += `url("${await resourceToDataUrl(resourceUrl, cache)}")`;
        cursor = Number(match.index) + match[0].length;
    }
    return result + String(value).slice(cursor);
}

function assertOriginCleanResources(root) {
    for (const element of [root, ...root.querySelectorAll('*')]) {
        for (let index = 0; index < element.style.length; index += 1) {
            const property = element.style.item(index);
            if (externalCssResourceUrls(element.style.getPropertyValue(property)).length) {
                throw new Error('The group contains a visual resource that could not be embedded safely.');
            }
        }
    }
    for (const image of root.querySelectorAll('img, image')) {
        const url = String(image.getAttribute('src') || image.getAttribute('href') || '').trim();
        if (!isEmbeddedResourceUrl(url)) {
            throw new Error('The group contains an image that could not be embedded safely.');
        }
    }
}

async function inlineComputedStyleResources(root, cache) {
    const elements = [root, ...root.querySelectorAll('*')];
    await Promise.all(elements.map(async (element) => {
        const properties = [];
        for (let index = 0; index < element.style.length; index += 1) {
            const property = element.style.item(index);
            const value = element.style.getPropertyValue(property);
            if (value.includes('url(')) properties.push({property, value, priority: element.style.getPropertyPriority(property)});
        }
        for (const {property, value, priority} of properties) {
            element.style.setProperty(property, await inlineCssValue(value, cache), priority);
        }
    }));
}

async function inlineSvgImageResources(root, cache) {
    await Promise.all([...root.querySelectorAll('image')].map(async (image) => {
        const href = String(image.getAttribute('href') || image.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '').trim();
        if (isEmbeddedResourceUrl(href)) return;
        const dataUrl = await resourceToDataUrl(href, cache);
        image.setAttribute('href', dataUrl);
        image.removeAttributeNS('http://www.w3.org/1999/xlink', 'href');
    }));
}

async function inlineImages(imagePairs, cache) {
    await Promise.all(imagePairs.map(async ({source, clone}) => {
        const url = String(source.currentSrc || source.src || '').trim();
        clone.removeAttribute('srcset');
        clone.removeAttribute('sizes');
        if (isEmbeddedResourceUrl(url)) {
            if (url) clone.setAttribute('src', url);
            return;
        }
        clone.setAttribute('src', await resourceToDataUrl(url, cache));
    }));
}

async function inlineVisualResources(root, imagePairs) {
    const cache = new Map();
    for (const source of root.querySelectorAll('source[srcset]')) {
        source.removeAttribute('srcset');
        source.removeAttribute('sizes');
    }
    await inlineImages(imagePairs, cache);
    await inlineSvgImageResources(root, cache);
    await inlineComputedStyleResources(root, cache);
    assertOriginCleanResources(root);
}

function canvasToPng(canvas) {
    return new Promise((resolve, reject) => canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('The browser could not create the PNG file.')),
        'image/png',
    ));
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

export const blackboardExportMethods = {
    closeGroupExportMenu() {
        this.groupExportMenu?.remove?.();
        this.groupExportMenu = null;
    },

    toggleGroupExportMenu(menu, button) {
        if (this.groupExportMenu?.isConnected) {
            this.closeGroupExportMenu();
            button?.setAttribute?.('aria-expanded', 'false');
            return;
        }
        const choices = document.createElement('div');
        choices.className = 'webmeet-blackboard-group-export-menu';
        choices.setAttribute('role', 'menu');
        choices.setAttribute('aria-label', 'Export group as PNG');
        for (const [background, label] of [['transparent', 'PNG transparent'], ['board', 'PNG with board background']]) {
            const choice = document.createElement('button');
            choice.type = 'button';
            choice.className = 'webmeet-blackboard-group-export-choice';
            choice.dataset.groupExportBackground = background;
            choice.setAttribute('role', 'menuitem');
            choice.textContent = label;
            choice.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                void this.exportSelectedGroup({background});
            });
            choices.append(choice);
        }
        choices.addEventListener('pointerdown', (event) => event.stopPropagation());
        menu.append(choices);
        this.groupExportMenu = choices;
        button?.setAttribute?.('aria-expanded', 'true');
    },

    showGroupExportError(error) {
        const message = error?.message || 'The selected group could not be exported.';
        if (typeof globalThis.assistOS?.showToast === 'function') globalThis.assistOS.showToast(message, 'error', 4500);
        else globalThis.alert?.(message);
    },

    async exportSelectedGroup({background = 'transparent'} = {}) {
        const groupId = String(this.selectedGroupId || '').trim();
        if (!groupId || this.groupExportBusy) return;
        if (!['transparent', 'board'].includes(background)) {
            this.showGroupExportError(new Error('Choose a supported group export background.'));
            return;
        }
        this.groupExportBusy = true;
        this.groupExportMenu?.querySelectorAll?.('button')?.forEach?.((button) => { button.disabled = true; });
        try {
            const widgets = selectGroupExportWidgets(this.blackboard?.widgets || [], groupId);
            if (widgets.filter((widget) => String(widget.groupId || '') === groupId).length < 2) {
                throw new Error('Select a group with at least two widgets before exporting it.');
            }
            const entries = widgets.map((widget) => ({widget, node: this.widgetNodes.get(widget.id)}));
            if (entries.some((entry) => !entry.node)) throw new Error('The group is not fully rendered yet. Try exporting it again.');
            const metrics = entries.map((entry) => rootMetrics(entry.node, this.projectAttachedConnection(entry.widget)));
            const bounds = calculateRotatedBounds(metrics);
            if (!bounds) throw new Error('The selected group has no visible content to export.');
            const logicalWidth = Math.ceil(bounds.width + EXPORT_PADDING * 2);
            const logicalHeight = Math.ceil(bounds.height + EXPORT_PADDING * 2);
            const stage = document.createElement('div');
            stage.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
            Object.assign(stage.style, {
                position: 'relative', width: `${logicalWidth}px`, height: `${logicalHeight}px`,
                overflow: 'hidden', margin: '0', padding: '0',
                background: background === 'board' ? this.getBlackboardBackground().color : 'transparent',
            });
            const imagePairs = [];
            for (const [index, entry] of entries.entries()) {
                const clone = cloneVisibleTree(entry.node, imagePairs);
                if (!clone) continue;
                const item = metrics[index];
                clone.classList.remove('is-group-member', 'is-group-selected-member', 'is-multi-selected', 'is-fullscreen');
                clone.removeAttribute('aria-selected');
                Object.assign(clone.style, {
                    position: 'absolute', left: `${item.x - bounds.x + EXPORT_PADDING}px`,
                    top: `${item.y - bounds.y + EXPORT_PADDING}px`, width: `${item.width}px`, height: `${item.height}px`,
                    margin: '0', transform: item.rotation ? `rotate(${item.rotation}deg)` : 'none',
                    transformOrigin: 'center center', zIndex: String(index + 1),
                });
                stage.append(clone);
            }
            await inlineVisualResources(stage, imagePairs);
            const scale = calculatePngScale(logicalWidth, logicalHeight);
            Object.assign(stage.style, {
                position: 'fixed', left: '0', top: '0', zIndex: '-2147483648', pointerEvents: 'none',
            });
            document.body.append(stage);
            let canvas;
            try {
                canvas = await html2canvas(stage, {
                    allowTaint: false,
                    backgroundColor: null,
                    foreignObjectRendering: false,
                    height: logicalHeight,
                    logging: false,
                    scale,
                    scrollX: 0,
                    scrollY: 0,
                    useCORS: false,
                    width: logicalWidth,
                    windowHeight: logicalHeight,
                    windowWidth: logicalWidth,
                });
            } finally {
                stage.remove();
            }
            triggerDownload(await canvasToPng(canvas), groupExportFilename(background));
            this.closeGroupExportMenu();
        } catch (error) {
            console.error('[WebMeetBlackboard] Group export failed', error);
            this.showGroupExportError(error);
        } finally {
            this.groupExportBusy = false;
            this.groupExportMenu?.querySelectorAll?.('button')?.forEach?.((button) => { button.disabled = false; });
        }
    },
};
