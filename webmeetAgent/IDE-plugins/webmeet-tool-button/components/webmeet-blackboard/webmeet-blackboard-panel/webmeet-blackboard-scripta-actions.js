const SCRIPTA_DOCUMENT_WIDGET_ID = 'robo_scripta_document';

import { groupExportFilename } from './webmeet-blackboard-export.js';

function decodeActionValue(value) {
    return value === '-' ? '' : decodeURIComponent(value);
}

const SCRIPTA_ACTIONS_WITHOUT_EXPLICIT_TARGET = new Set([
    'scripta-document-view',
    'scripta-paragraph-previous',
    'scripta-paragraph-next',
]);

export const blackboardScriptaActionMethods = {
    async startScriptaVariantEdit(variantsView, payload = {}) {
        const variantId = String(payload.variantId || '');
        if (!this.adapter?.sendEvent || this.busy) {
            variantsView?.webSkelPresenter?.rejectEditStart?.(variantId);
            return null;
        }
        try {
            return await this.adapter.sendEvent('scripta-p-variant-edit-start', payload, {
                widgetId: SCRIPTA_DOCUMENT_WIDGET_ID,
                targetType: 'widget',
                projectionMode: 'state',
            });
        } catch (error) {
            this.clearScriptaDraft();
            variantsView?.webSkelPresenter?.rejectEditStart?.(variantId);
            const message = error?.message || 'SCRIPTA edit could not be started.';
            globalThis.assistOS?.showToast?.(message, 'error', 4000);
            return null;
        }
    },

    async pickScriptaImage() {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/png,image/jpeg,image/webp,image/gif';
            input.addEventListener('change', () => resolve(input.files?.[0] || null), {once: true});
            input.click();
        });
    },

    async uploadPickedScriptaImage(file) {
        const mimeType = String(file?.type || '').trim();
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType)) {
            throw new Error('Choose a PNG, JPEG, WebP, or GIF image.');
        }
        if (Number(file?.size || 0) > 15 * 1024 * 1024) throw new Error('Images may not exceed 15 MB.');
        const name = String(file?.name || 'Image').trim() || 'Image';
        const asset = await this.uploadBlackboardImageBlob(file, name, mimeType);
        if (!asset?.id) throw new Error('Explorer did not return an image asset.');
        return {assetId: asset.id, alt: name};
    },

    async insertScriptaVariantImage(target = {}) {
        if (!this.adapter?.mutateScriptaVariantImage || this.busy) return;
        const file = await this.pickScriptaImage();
        if (!file) return;
        this.busy = true;
        try {
            const {text, ...imageTarget} = target;
            if (text !== undefined) {
                this.clearScriptaDraft();
                await this.adapter.applyScriptaVariantEdit?.({...imageTarget, text});
            }
            const asset = await this.uploadPickedScriptaImage(file);
            await this.adapter.mutateScriptaVariantImage('insert', {...imageTarget, ...asset});
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The image could not be added to the variant.', 'error', 4000);
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    async insertScriptaChapterImage(target) {
        if (!this.adapter?.addScriptaImageParagraph || this.busy) return;
        const chapterId = String(target?.dataset?.chapterId || '').trim();
        if (!chapterId) return;
        const file = await this.pickScriptaImage();
        if (!file) return;
        this.busy = true;
        try {
            const asset = await this.uploadPickedScriptaImage(file);
            await this.adapter.addScriptaImageParagraph({chapterId, ...asset});
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The image paragraph could not be added.', 'error', 4000);
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    async replaceScriptaVariantImage(target = {}) {
        if (!this.adapter?.mutateScriptaVariantImage || this.busy) return;
        const file = await this.pickScriptaImage();
        if (!file) return;
        this.busy = true;
        try {
            const asset = await this.uploadPickedScriptaImage(file);
            await this.adapter.mutateScriptaVariantImage('replace', {
                ...target,
                ...asset,
            });
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The variant image could not be replaced.', 'error', 4000);
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    async deleteScriptaVariantImage(target = {}) {
        if (!this.adapter?.mutateScriptaVariantImage || this.busy) return;
        this.busy = true;
        try {
            await this.adapter.mutateScriptaVariantImage('delete', target);
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The variant image could not be removed.', 'error', 4000);
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    async updateScriptaVariantImageLayout(target = {}) {
        if (!this.adapter?.mutateScriptaVariantImage) return;
        try {
            await this.adapter.mutateScriptaVariantImage('layout', target);
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The image layout could not be changed.', 'error', 4000);
        }
    },

    async insertSelectedGroupIntoScripta({background = 'transparent', alt = 'Blackboard diagram', throwOnError = false} = {}) {
        if (!this.adapter?.commitMediaBlob || !this.adapter?.insertScriptaMedia) return;
        try {
            const blob = await this.exportSelectedGroup({background, download: false, throwOnError});
            if (!blob) throw new Error('The selected group could not be rendered.');
            const filename = groupExportFilename(background);
            const upload = await fetch('/blobs/explorer', {
                method: 'POST',
                headers: {
                    'Content-Type': 'image/png',
                    'X-Mime-Type': 'image/png',
                    'X-File-Name': encodeURIComponent(filename)
                },
                body: blob
            });
            if (!upload.ok) throw new Error((await upload.text().catch(() => '')) || `Diagram upload failed (${upload.status}).`);
            const staged = await upload.json();
            const asset = await this.adapter.commitMediaBlob(staged, filename);
            if (!asset?.assetId) throw new Error('Explorer did not return a diagram asset.');
            await this.adapter.insertScriptaMedia(asset.assetId, alt);
        } catch (error) {
            console.error('[WebMeetBlackboard] SCRIPTA group insertion failed', error);
            this.showGroupExportError(error);
            if (throwOnError) throw error;
        }
    },

    appendImageScriptaButton(menu, widget) {
        if (widget?.type !== 'image' || !widget.properties?.source?.assetId) return;
        const button = this.createContextButton('insert', 'Insert into SCRIPTA', 'Insert into SCRIPTA', 'insert');
        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.insertImageWidgetIntoScripta(widget);
        });
        menu.append(button);
    },

    async insertImageWidgetIntoScripta(widget) {
        const assetId = String(widget?.properties?.source?.assetId || '').trim();
        if (!assetId || !this.adapter?.insertScriptaMedia || this.busy) return;
        this.busy = true;
        try {
            await this.adapter.insertScriptaMedia(assetId, widget.properties?.alt || widget.properties?.source?.name || 'Image');
        } catch (error) {
            globalThis.assistOS?.showToast?.(error?.message || 'The image could not be inserted into SCRIPTA.', 'error', 4000);
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    openScriptaChapterTitleEditor(target) {
        const titleEditor = target?.closest?.('[data-role="chapter-title-editor"]');
        if (!titleEditor || this.busy) return;
        const title = titleEditor.querySelector('[data-role="chapter-title"]');
        const editor = titleEditor.querySelector('[data-role="chapter-title-edit"]');
        const input = titleEditor.querySelector('[data-role="chapter-title-input"]');
        if (!title || !editor || !input) return;

        input.value = titleEditor.dataset.originalTitle || '';
        title.hidden = true;
        editor.hidden = false;
        titleEditor.closest('header')?.classList.add('is-title-editing');
        input.focus({preventScroll: true});
        input.select();
    },

    cancelScriptaChapterTitleEditor(target) {
        const titleEditor = target?.closest?.('[data-role="chapter-title-editor"]');
        if (!titleEditor || this.busy) return;
        const title = titleEditor.querySelector('[data-role="chapter-title"]');
        const editor = titleEditor.querySelector('[data-role="chapter-title-edit"]');
        const input = titleEditor.querySelector('[data-role="chapter-title-input"]');
        if (!title || !editor || !input) return;

        input.value = titleEditor.dataset.originalTitle || '';
        editor.hidden = true;
        title.hidden = false;
        titleEditor.closest('header')?.classList.remove('is-title-editing');
        title.focus({preventScroll: true});
    },

    async saveScriptaChapterTitleEditor(target) {
        const titleEditor = target?.closest?.('[data-role="chapter-title-editor"]');
        if (!titleEditor || this.busy) return;
        const input = titleEditor.querySelector('[data-role="chapter-title-input"]');
        const save = titleEditor.querySelector('[data-role="chapter-title-save"]');
        const cancel = titleEditor.querySelector('[data-role="chapter-title-cancel"]');
        if (!input || !save || !cancel) return;

        const originalTitle = titleEditor.dataset.originalTitle || '';
        const fallbackTitle = titleEditor.dataset.fallbackTitle || 'Chapter';
        const nextTitle = String(input.value || '').replace(/\s+/g, ' ').trim() || fallbackTitle;
        if (nextTitle === originalTitle) {
            this.cancelScriptaChapterTitleEditor(target);
            return;
        }

        save.disabled = true;
        cancel.disabled = true;
        await this.runScriptaEvent('scripta-chapter-edit', {
            chapterId: titleEditor.dataset.chapterId,
            title: nextTitle,
        });
        if (titleEditor.isConnected) {
            save.disabled = false;
            cancel.disabled = false;
        }
    },

    runScriptaLocalAction(
        target,
        action = '',
        encodedChapterId = '',
        encodedParagraphId = '',
        chapterOrdinal = '',
        paragraphOrdinal = '',
        encodedMoveDirection = ''
    ) {
        if (target?.disabled || !action) return;
        const chapterId = decodeActionValue(encodedChapterId);
        const paragraphId = decodeActionValue(encodedParagraphId);
        const moveDirection = decodeActionValue(encodedMoveDirection);
        const payload = {};
        if (!SCRIPTA_ACTIONS_WITHOUT_EXPLICIT_TARGET.has(action)) {
            if (chapterId) payload.chapterId = chapterId;
            if (paragraphId) payload.paragraphId = paragraphId;
        }

        if (action === 'scripta-paragraph-add') payload.text = '';
        if (action === 'scripta-chapter-move') {
            const ordinal = Number(chapterOrdinal);
            payload.targetIndex = moveDirection === 'up' ? ordinal - 1 : ordinal + 1;
        }
        if (action === 'scripta-paragraph-move') {
            const ordinal = Number(paragraphOrdinal);
            payload.targetChapterId = chapterId;
            payload.targetIndex = moveDirection === 'up' ? ordinal - 1 : ordinal + 1;
        }
        void this.runScriptaEvent(action, payload);
    },

    async runScriptaEvent(action, payload) {
        if (!this.adapter?.sendEvent || this.busy) return null;
        this.busy = true;
        try {
            const response = await this.adapter.sendEvent(action, payload, {
                widgetId: SCRIPTA_DOCUMENT_WIDGET_ID,
                targetType: 'widget'
            });
            if (response?.blackboard) {
                this.applyBlackboard(response.blackboard);
            } else {
                await this.adapter.requestResync?.(action);
            }
            return response;
        } catch (error) {
            const message = error?.message || 'SCRIPTA action failed.';
            globalThis.assistOS?.showToast?.(message, 'error', 4000);
            return null;
        } finally {
            this.busy = false;
            this.renderWidgets();
        }
    },

    async promptScriptaCreate(canBrowseWorkspace = false) {
        const entries = canBrowseWorkspace ? await this.adapter?.listScriptaWorkspaceEntries?.() : null;
        const result = await globalThis.assistOS?.UI?.showModal?.('webmeet-scripta-document-modal', {
            mode: 'create',
            'can-browse': String(canBrowseWorkspace),
            'entries-json': encodeURIComponent(JSON.stringify(entries || {})),
        }, true);
        if (result?.mode !== 'create') return;
        await this.runScriptaEvent('scripta-document-create', result);
    },

    async promptScriptaOpen() {
        const entries = await this.adapter?.listScriptaWorkspaceEntries?.();
        const result = await globalThis.assistOS?.UI?.showModal?.('webmeet-scripta-document-modal', {
            mode: 'open',
            'can-browse': 'true',
            'entries-json': encodeURIComponent(JSON.stringify(entries || {})),
        }, true);
        if (result?.mode !== 'open') return;
        await this.runScriptaEvent('scripta-document-open', {path: result.path});
    },

    async handleScriptaToolbarAction({operation = '', path = ''} = {}) {
        if (operation === 'list') {
            try {
                const entries = await this.adapter?.listScriptaWorkspaceEntries?.();
                this.toolbar?.setState?.({scriptaWorkspaceEntries: entries || null, scriptaWorkspaceLoading: false});
            } catch {
                this.toolbar?.setState?.({scriptaWorkspaceEntries: null, scriptaWorkspaceLoading: false});
            }
            return;
        }
        if (operation === 'create') {
            let entries = null;
            try {
                entries = await this.adapter?.listScriptaWorkspaceEntries?.();
            } catch {}
            await this.promptScriptaCreate(Boolean(entries));
            return;
        }
        if (operation === 'open-path' && path) {
            await this.runScriptaEvent('scripta-document-open', {path});
            return;
        }
        if (operation === 'open-other') await this.promptScriptaOpen();
    },

    routeScriptaWheelToBlackboard(event) {
        const board = this.board;
        if (!board || event.defaultPrevented) return;
        const unit = event.deltaMode === 1
            ? 16
            : event.deltaMode === 2
                ? Math.max(1, board.clientHeight)
                : 1;
        let deltaX = Number(event.deltaX || 0) * unit;
        let deltaY = Number(event.deltaY || 0) * unit;
        if (event.shiftKey && !deltaX) {
            deltaX = deltaY;
            deltaY = 0;
        }
        const maxLeft = Math.max(0, board.scrollWidth - board.clientWidth);
        const maxTop = Math.max(0, board.scrollHeight - board.clientHeight);
        const nextLeft = Math.min(maxLeft, Math.max(0, board.scrollLeft + deltaX));
        const nextTop = Math.min(maxTop, Math.max(0, board.scrollTop + deltaY));
        if (nextLeft === board.scrollLeft && nextTop === board.scrollTop) return;
        board.scrollLeft = nextLeft;
        board.scrollTop = nextTop;
        event.preventDefault();
        event.stopPropagation();
    }
};
