function formatFileSize(value) {
    const bytes = Math.max(0, Number(value || 0));
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let size = bytes / 1024;
    let unit = units[0];
    for (let index = 1; index < units.length && size >= 1024; index += 1) {
        size /= 1024;
        unit = units[index];
    }
    return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${unit}`;
}

export const blackboardAttachmentRenderingMethods = {
    appendFileContextDownload(menu, widget) {
        if (widget?.type !== 'file') return;
        const source = widget.properties?.source || {};
        const template = this.element.querySelector('template[data-template="file-context-download"]');
        const button = template?.content?.cloneNode(true)?.querySelector?.('[data-local-action="downloadBlackboardFile"]');
        if (!button) return;
        const filename = String(source.name || 'file');
        button.title = `Download ${filename}`;
        button.setAttribute('aria-label', `Download ${filename}`);
        menu.append(button);
    },

    renderAttachmentWidgetContent(node, widget) {
        const source = widget.properties?.source || {};
        if (widget.type === 'image') {
            const frame = document.createElement('div');
            frame.className = 'webmeet-blackboard-image-frame';
            const image = document.createElement('img');
            image.className = 'webmeet-blackboard-image';
            image.alt = String(widget.properties?.alt || source.name || 'Image');
            image.draggable = false;
            image.src = String(source.url || source.downloadUrl || widget.properties?.src || '');
            frame.append(image);
            node.append(frame);
            return;
        }
        const template = this.element.querySelector('template[data-template="file-widget"]');
        const card = template?.content?.cloneNode(true)?.querySelector?.('.webmeet-blackboard-file-card');
        if (!card) return;
        const extension = String(source.extension || '').trim().toUpperCase() || 'FILE';
        card.querySelector('[data-role="file-extension"]').textContent = extension;
        card.querySelector('[data-role="file-name"]').textContent = String(source.name || 'File');
        card.querySelector('[data-role="file-meta"]').textContent = [
            String(source.mimeType || 'application/octet-stream'),
            formatFileSize(source.size)
        ].join(' · ');
        node.append(card);
    }
};
