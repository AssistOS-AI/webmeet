function setText(root, selector, text) {
    const node = root.querySelector(selector);
    if (node) node.textContent = text;
    return node;
}

function setActionContext(root, context = {}) {
    for (const action of root.querySelectorAll('[data-local-action^="runScriptaLocalAction"]')) {
        const [, eventAction = ''] = action.dataset.localAction.split(/\s+/, 2);
        const values = [
            context.chapterId,
            context.paragraphId,
            context.chapterOrdinal,
            context.paragraphOrdinal,
            action.dataset.moveDirection,
        ].map((value) => {
            const normalized = String(value ?? '');
            return normalized ? encodeURIComponent(normalized) : '-';
        });
        action.dataset.localAction = `runScriptaLocalAction ${eventAction} ${values.join(' ')}`;
    }
}

export const blackboardScriptaRenderingMethods = {
    cloneScriptaTemplate(name) {
        const template = this.element.querySelector(`template[data-template="${name}"]`);
        const root = template?.content?.firstElementChild?.cloneNode(true);
        if (!root) throw new Error(`Missing SCRIPTA template: ${name}`);
        return root;
    },

    cloneScriptaTemplateContent(name) {
        const template = this.element.querySelector(`template[data-template="${name}"]`);
        const content = template?.content?.cloneNode(true);
        if (!content) throw new Error(`Missing SCRIPTA template: ${name}`);
        return content;
    },

    renderScriptaDocument(node, widget) {
        const props = widget.properties || {};
        node.addEventListener('wheel', (event) => this.routeScriptaWheelToBlackboard(event), {
            capture: true,
            passive: false,
        });

        const shell = this.cloneScriptaTemplate('scripta-document');
        shell.addEventListener('pointerdown', (event) => event.stopPropagation());
        setText(shell, '[data-role="document-title"]', props.documentTitle || 'SCRIPTA Document');
        const documentHeader = shell.querySelector('.webmeet-scripta-document-header');
        const documentPosition = shell.querySelector('[data-role="document-position"]');
        const paragraph = props.paragraph || {};
        const isParagraphMode = Boolean(props.resourceId && props.viewMode === 'paragraph');
        documentHeader.classList.toggle('is-paragraph-mode', isParagraphMode);
        documentPosition.hidden = !isParagraphMode;
        if (isParagraphMode) {
            documentPosition.textContent = `Chapter ${paragraph.chapterOrdinal || 1} - Paragraph ${paragraph.paragraphOrdinal || 1}`;
        }

        const addChapter = shell.querySelector('[data-local-action*="scripta-chapter-add"]');
        addChapter.hidden = !props.resourceId || props.viewMode === 'paragraph';
        const content = shell.querySelector('[data-role="document-content"]');
        if (!props.resourceId) {
            content.replaceWith(this.cloneScriptaTemplate('scripta-empty'));
        } else if (props.viewMode === 'paragraph') {
            content.replaceWith(this.createScriptaParagraphMode(props));
        } else {
            const chapters = document.createDocumentFragment();
            for (const chapter of props.chapters || []) {
                chapters.append(this.createScriptaChapter(chapter, props.chapters.length));
            }
            content.replaceWith(chapters);
        }
        node.append(shell);

        if (props.viewMode === 'document') queueMicrotask(() => this.focusScriptaDocumentTarget(node, props));
    },

    focusScriptaDocumentTarget(node, props) {
        const revision = Number(props.documentRevision || 0);
        const shouldAutoFocus = revision > 0 && Number(props.autoFocusRevision || 0) === revision;
        const targetType = props.focusTargetType === 'chapter' ? 'chapter' : 'paragraph';
        const targetId = targetType === 'chapter' ? props.focusedChapterId : props.focusedParagraphId;
        const selector = targetType === 'chapter'
            ? `[data-chapter-id="${CSS.escape(targetId || '')}"]`
            : `[data-paragraph-id="${CSS.escape(targetId || '')}"]`;
        const target = targetId ? node.querySelector(selector) : null;
        if (!target) return;

        if (!shouldAutoFocus) {
            if (props.focusedParagraphId) target.scrollIntoView({block: 'center'});
            return;
        }
        const focusKey = `${props.resourceId}:${revision}:${targetType}:${targetId}`;
        if (this.lastScriptaAutoFocusKey === focusKey) return;
        this.lastScriptaAutoFocusKey = focusKey;
        target.scrollIntoView({block: 'nearest', inline: 'nearest'});
        const focusTarget = targetType === 'chapter'
            ? target.querySelector('h3')
            : target.querySelector('.webmeet-scripta-paragraph-open');
        focusTarget?.focus?.({preventScroll: true});
    },

    createScriptaChapter(chapter, chapterCount) {
        const chapterNode = this.cloneScriptaTemplate('scripta-chapter');
        chapterNode.dataset.chapterId = chapter.chapterId;
        setActionContext(chapterNode, {
            chapterId: chapter.chapterId,
            chapterOrdinal: chapter.chapterOrdinal,
        });

        const titleEditor = chapterNode.querySelector('[data-role="chapter-title-editor"]');
        this.configureScriptaChapterTitle(titleEditor, chapter);
        const moveUp = chapterNode.querySelector('[data-move-direction="up"]');
        const moveDown = chapterNode.querySelector('[data-move-direction="down"]');
        const deleteChapter = chapterNode.querySelector('[data-local-action*="scripta-chapter-delete"]');
        moveUp.disabled = chapter.chapterOrdinal <= 1;
        moveDown.disabled = chapter.chapterOrdinal >= chapterCount;
        deleteChapter.disabled = chapterCount <= 1;

        const paragraphs = chapterNode.querySelector('[data-role="chapter-paragraphs"]');
        for (const paragraph of chapter.paragraphs || []) {
            paragraphs.append(this.createScriptaParagraphCard(chapter, paragraph));
        }
        return chapterNode;
    },

    configureScriptaChapterTitle(titleEditor, chapter) {
        const fallbackTitle = `Chapter ${chapter.chapterOrdinal}`;
        const originalTitle = chapter.chapterTitle || fallbackTitle;
        const title = titleEditor.querySelector('[data-role="chapter-title"]');
        const editor = titleEditor.querySelector('[data-role="chapter-title-edit"]');
        const input = titleEditor.querySelector('[data-role="chapter-title-input"]');

        titleEditor.dataset.chapterId = chapter.chapterId;
        titleEditor.dataset.originalTitle = originalTitle;
        titleEditor.dataset.fallbackTitle = fallbackTitle;
        title.textContent = originalTitle;
        title.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                this.openScriptaChapterTitleEditor(title);
            }
        });
        editor.addEventListener('pointerdown', (event) => event.stopPropagation());
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                this.cancelScriptaChapterTitleEditor(input);
            } else if (event.key === 'Enter') {
                event.preventDefault();
                void this.saveScriptaChapterTitleEditor(input);
            }
        });
    },

    createScriptaParagraphCard(chapter, paragraph) {
        const paragraphNode = this.cloneScriptaTemplate('scripta-paragraph-card');
        paragraphNode.dataset.paragraphId = paragraph.paragraphId;
        setActionContext(paragraphNode, {
            chapterId: chapter.chapterId,
            chapterOrdinal: chapter.chapterOrdinal,
            paragraphId: paragraph.paragraphId,
            paragraphOrdinal: paragraph.paragraphOrdinal,
        });

        const paragraphText = String(paragraph.text || '');
        const text = setText(
            paragraphNode,
            '[data-role="paragraph-text"]',
            paragraphText || 'Empty paragraph — select to add text.'
        );
        text.classList.toggle('is-placeholder', !paragraphText);
        paragraphNode.querySelector('[data-move-direction="up"]').disabled = paragraph.paragraphOrdinal <= 1;
        paragraphNode.querySelector('[data-move-direction="down"]').disabled = (
            paragraph.paragraphOrdinal >= chapter.paragraphs.length
        );
        return paragraphNode;
    },

    createScriptaParagraphMode(props) {
        const paragraph = props.paragraph || {};
        const mode = this.cloneScriptaTemplateContent('scripta-paragraph-mode');
        setActionContext(mode, {
            chapterId: paragraph.chapterId,
            paragraphId: paragraph.paragraphId,
        });

        const paragraphOrder = (props.chapters || []).flatMap((chapter) => (
            (chapter.paragraphs || []).map((entry) => entry.paragraphId)
        ));
        const paragraphIndex = paragraphOrder.indexOf(paragraph.paragraphId);
        mode.querySelector('[data-local-action*="scripta-paragraph-previous"]').disabled = paragraphIndex <= 0;
        mode.querySelector('[data-local-action*="scripta-paragraph-next"]').disabled = (
            paragraphIndex < 0 || paragraphIndex >= paragraphOrder.length - 1
        );
        setText(mode, '[data-role="chapter-title"]', paragraph.chapterTitle || 'Untitled chapter');
        void this.adapter?.openScriptaCollaboration?.(props.resourceId).catch((error) => {
            console.error('[WebMeetBlackboard] Could not open SCRIPTA collaboration replica', error);
        });
        this.configureScriptaVariantsView(mode.querySelector('[data-role="variants-view"]'), paragraph, props.resourceId);
        return mode;
    },

    configureScriptaVariantsView(variantsView, paragraph, resourceId) {
        variantsView.addEventListener('pointerdown', (event) => event.stopPropagation());
        variantsView.addEventListener('scripta-p-variant-select', (event) => void this.runScriptaEvent(
            'scripta-p-variant-select',
            {
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
            }
        ));
        variantsView.addEventListener('scripta-p-variant-edit', (event) => {
            this.clearScriptaDraft();
            void this.adapter?.applyScriptaVariantEdit?.({
                resourceId,
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
                text: event.detail?.text,
            }).catch((error) => {
                const message = error?.message || 'SCRIPTA edit failed.';
                globalThis.assistOS?.showToast?.(message, 'error', 4000);
            });
        });
        variantsView.addEventListener('scripta-p-variant-edit-start', (event) => {
            this.scriptaEditStartPromise = this.runScriptaEvent('scripta-p-variant-edit-start', {
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
            });
        });
        variantsView.addEventListener('scripta-p-variant-edit-draft', (event) => {
            this.queueScriptaDraft({
                resourceId,
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
                text: event.detail?.text,
            });
        });
        variantsView.addEventListener('scripta-p-variant-edit-cancel', (event) => {
            this.clearScriptaDraft();
            void this.runScriptaEvent('scripta-p-variant-edit-cancel', {
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
            });
        });
        variantsView.addEventListener('scripta-p-variant-vote', (event) => void this.runScriptaEvent(
            event.detail?.withdraw ? 'scripta-p-variant-vote-withdraw' : 'scripta-p-variant-vote',
            {
                chapterId: paragraph.chapterId,
                paragraphId: paragraph.paragraphId,
                variantId: event.detail?.variantId,
                type: event.detail?.type,
            }
        ));
        variantsView.addEventListener('scripta-p-variant-add', (event) => void this.runScriptaEvent('scripta-p-variant-add', {
            chapterId: paragraph.chapterId,
            paragraphId: paragraph.paragraphId,
            text: event.detail?.text,
        }));
        variantsView.addEventListener('scripta-p-variant-delete', (event) => void this.runScriptaEvent('scripta-p-variant-delete', {
            chapterId: paragraph.chapterId,
            paragraphId: paragraph.paragraphId,
            variantId: event.detail?.variantId,
        }));
        variantsView.addEventListener('scripta-p-variant-reformulate', () => void this.runScriptaEvent('scripta-p-variant-reformulate', {
            chapterId: paragraph.chapterId,
            paragraphId: paragraph.paragraphId,
        }));

        const draft = this.scriptaDraft;
        const draftMatches = Boolean(
            draft
            && draft.resourceId === resourceId
            && draft.chapterId === paragraph.chapterId
            && draft.paragraphId === paragraph.paragraphId
            && draft.variantId === paragraph.editingVariantId
            && draft.editorParticipantId === paragraph.editorParticipantId
        );
        const viewData = {
            variants: (paragraph.variants || []).map((variant, index) => ({
                ...variant,
                ...(draftMatches && variant.id === draft.variantId ? {text: draft.text} : {}),
                ordinal: index + 1,
            })),
            activeVariantId: paragraph.activeVariantId,
            selectedVariantId: paragraph.selectedVariantId,
            editingVariantId: paragraph.editingVariantId,
            viewerVote: paragraph.viewerVote || null,
            editable: true,
            allowAdd: true,
            allowReformulate: true,
            disabled: this.busy,
        };
        void (async () => {
            await customElements.whenDefined('scripta-variants-view');
            customElements.upgrade(variantsView);
            await variantsView.presenterReadyPromise;
            variantsView.webSkelPresenter?.setData?.(viewData);
        })();
    },

    queueScriptaDraft(presentation = {}) {
        this.pendingScriptaDraft = {
            ...presentation,
            editorParticipantId: this.adapter?.participantId || '',
            text: String(presentation.text ?? ''),
        };
        if (this.scriptaDraftTimer) clearTimeout(this.scriptaDraftTimer);
        this.scriptaDraftTimer = setTimeout(() => {
            this.scriptaDraftTimer = null;
            const pending = this.pendingScriptaDraft;
            this.pendingScriptaDraft = null;
            void Promise.resolve(this.scriptaEditStartPromise)
                .then((started) => {
                    if (!started || !pending) return;
                    return this.adapter?.publishScriptaDraft?.(pending);
                })
                .catch((error) => {
                    console.error('[WebMeetBlackboard] Could not publish SCRIPTA draft', error);
                });
        }, 60);
    },

    clearScriptaDraft() {
        if (this.scriptaDraftTimer) clearTimeout(this.scriptaDraftTimer);
        this.scriptaDraftTimer = null;
        this.pendingScriptaDraft = null;
        this.scriptaDraft = null;
    },

    applyScriptaPresentation(presentation = {}) {
        if (presentation.type !== 'scripta-variant-draft') return;
        const widget = (this.blackboard?.widgets || []).find(
            (entry) => entry.id === 'robo_scripta_document'
        );
        const paragraph = widget?.properties?.paragraph;
        if (
            !paragraph
            || widget.properties.resourceId !== presentation.resourceId
            || paragraph.chapterId !== presentation.chapterId
            || paragraph.paragraphId !== presentation.paragraphId
            || paragraph.editingVariantId !== presentation.variantId
            || paragraph.editorParticipantId !== presentation.editorParticipantId
        ) {
            return;
        }
        this.scriptaDraft = {
            ...presentation,
            text: String(presentation.text ?? ''),
        };
        const variantsView = this.board?.querySelector?.(
            '[data-widget-id="robo_scripta_document"] scripta-variants-view'
        );
        const presenter = variantsView?.webSkelPresenter;
        if (presenter?.applyRemoteDraft) {
            presenter.applyRemoteDraft(this.scriptaDraft);
            return;
        }
        this.renderWidgets();
    }
};
