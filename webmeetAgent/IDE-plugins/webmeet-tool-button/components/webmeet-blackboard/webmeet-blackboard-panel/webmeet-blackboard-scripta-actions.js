const SCRIPTA_DOCUMENT_WIDGET_ID = 'robo_scripta_document';

function decodeActionValue(value) {
    return value === '-' ? '' : decodeURIComponent(value);
}

export const blackboardScriptaActionMethods = {
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
        if (chapterId) payload.chapterId = chapterId;
        if (paragraphId) payload.paragraphId = paragraphId;

        if (action === 'scripta-paragraph-add') payload.text = '';
        if (action === 'scripta-chapter-move') {
            const ordinal = Number(chapterOrdinal);
            payload.targetIndex = moveDirection === 'up' ? ordinal - 1 : ordinal + 1;
        }
        if (action === 'scripta-paragraph-move') {
            const ordinal = Number(paragraphOrdinal);
            payload.targetChapterOrdinal = Number(chapterOrdinal);
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
