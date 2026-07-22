import { ROBO_TEAM_PARTICIPANT_ID } from '../roboTeam/service.mjs';
import { assertRoboCommand, normalizeRoboIntent } from './commands.mjs';
import {
    createScriptaDocument,
    focusScripta,
    getScriptaContext,
    manageScriptaDocument,
    mutateScripta,
    navigateScripta,
    openScriptaDocument,
} from './service.mjs';

function projectInterpreterContext(context = {}) {
    return {
        activeResourceId: String(context.activeResourceId || ''),
        view: context.view || { mode: 'document' },
        resources: (context.resources || []).map((resource) => ({ resourceId: resource.resourceId, title: resource.title })),
        documentOutline: (context.documentOutline || []).map((chapter) => ({
            chapterId: chapter.chapterId,
            ordinal: chapter.chapterOrdinal,
            title: chapter.chapterTitle,
            paragraphs: (chapter.paragraphs || []).map((paragraph) => ({
                paragraphId: paragraph.paragraphId,
                ordinal: paragraph.paragraphOrdinal,
            })),
        })),
        paragraph: context.paragraph ? {
            chapterId: context.paragraph.chapterId,
            paragraphId: context.paragraph.paragraphId,
            chapterOrdinal: context.paragraph.chapterOrdinal,
            paragraphOrdinal: context.paragraph.paragraphOrdinal,
            chapterTitle: context.paragraph.chapterTitle,
            currentText: context.paragraph.currentText,
            variants: (context.paragraph.variants || []).map((variant, index) => ({ id: variant.id, ordinal: index + 1, text: variant.text })),
        } : null,
    };
}

function presentation(roomId) {
    return {
        presenter: { participantId: ROBO_TEAM_PARTICIPANT_ID, name: 'RoboTeam' },
        visibilityPayload: {
            type: 'blackboard.visibility_changed', meetingId: roomId, participantId: ROBO_TEAM_PARTICIPANT_ID,
            presenterName: 'RoboTeam', visible: true, boardId: 'agent:agent_robo_team',
        },
    };
}

function resolveIds(current, parsed) {
    const requestedChapterId = parsed.chapterId || (!parsed.chapterOrdinal && !parsed.paragraphId ? current.view?.chapterId : '');
    const chapter = parsed.paragraphId && !parsed.chapterId && !parsed.chapterOrdinal
        ? current.documentOutline.find((item) => item.paragraphs?.some((paragraph) => paragraph.paragraphId === parsed.paragraphId))
        : requestedChapterId
            ? current.documentOutline.find((item) => item.chapterId === requestedChapterId)
            : current.documentOutline[parsed.chapterOrdinal ? parsed.chapterOrdinal - 1 : 0];
    const requestedParagraphId = parsed.paragraphId || (!parsed.paragraphOrdinal ? current.view?.paragraphId : '');
    const paragraph = requestedParagraphId
        ? chapter?.paragraphs?.find((item) => item.paragraphId === requestedParagraphId)
        : chapter?.paragraphs?.[parsed.paragraphOrdinal ? parsed.paragraphOrdinal - 1 : 0];
    return {
        chapterId: chapter?.chapterId || requestedChapterId || '',
        paragraphId: paragraph?.paragraphId || requestedParagraphId || '',
    };
}

export async function executeRoboCommand(context, {
    roomId, text, source = 'chat', participantId = '', authInfo = null,
} = {}, { reformulate = null, interpret = null, intent = null } = {}) {
    const normalizedSource = String(source || 'chat').trim().toLowerCase();
    if (!['chat', 'voice'].includes(normalizedSource)) throw new Error('Robo command source must be "chat" or "voice".');
    const command = assertRoboCommand(text);
    if (!intent && typeof interpret !== 'function') throw new Error('SCRIPTA AI command interpreter is unavailable.');
    let preview = null;
    const getPreview = async () => {
        preview ||= await getScriptaContext(context, { roomId, participantId, authInfo });
        return preview;
    };
    const parsed = normalizeRoboIntent(intent || await interpret({
        roomId,
        text: command.command,
        source: normalizedSource,
        participantId,
        context: projectInterpreterContext(await getPreview()),
    }));

    let response;
    if (parsed.kind === 'document') {
        if (parsed.operation === 'document-create') {
            if (parsed.template !== 'general' && !parsed.chapters.length && !parsed.visionParagraphs.length && !parsed.planParagraphs.length) {
                if (typeof reformulate !== 'function') throw new Error('SCRIPTA AI document generation is currently unavailable.');
                const generated = await reformulate({
                    task: 'create-scripta-document', template: parsed.template, objective: parsed.objective,
                    requirements: parsed.template === 'vision'
                        ? 'Return JSON with visionParagraphs containing at least three distinct aspect texts. Paragraphs do not have titles.'
                        : 'Return JSON with chapters; every chapter must contain at least one paragraph.',
                });
                const value = typeof generated === 'string' ? JSON.parse(generated) : generated;
                parsed.visionParagraphs = Array.isArray(value?.visionParagraphs) ? value.visionParagraphs : [];
                parsed.planParagraphs = Array.isArray(value?.planParagraphs) ? value.planParagraphs : [];
                parsed.chapters = Array.isArray(value?.chapters) ? value.chapters : [];
            }
            response = await createScriptaDocument(context, {
                roomId, name: parsed.name || parsed.title, template: parsed.template, folderPath: parsed.folderPath,
                initialization: {
                    title: parsed.title || parsed.name,
                    objective: parsed.objective,
                    visionParagraphs: parsed.visionParagraphs,
                    planParagraphs: parsed.planParagraphs,
                    chapters: parsed.chapters,
                }, participantId, authInfo,
            });
        } else if (parsed.operation === 'document-open') {
            response = await openScriptaDocument(context, { roomId, path: parsed.path, participantId, authInfo });
        } else {
            response = await manageScriptaDocument(context, {
                roomId, operation: parsed.operation, resourceId: parsed.resourceId, participantId, authInfo,
                confirmed: parsed.confirmed,
            });
        }
    } else if (parsed.kind === 'navigation') {
        response = await navigateScripta(context, { roomId, direction: parsed.direction, participantId, authInfo });
    } else if (parsed.kind === 'focus') {
        const ids = parsed.chapterId && parsed.paragraphId
            ? { chapterId: parsed.chapterId, paragraphId: parsed.paragraphId }
            : resolveIds(await getPreview(), parsed);
        response = await focusScripta(context, {
            roomId, resourceId: parsed.resourceId, ...ids, mode: parsed.mode || 'paragraph',
            variantId: parsed.variantId,
            editing: parsed.editing,
            participantId, authInfo,
        });
    } else {
        let mutation = parsed;
        let current = preview;
        if (parsed.kind === 'ai-reformulate') {
            if (typeof reformulate !== 'function') throw new Error('SCRIPTA AI reformulation is currently unavailable.');
            current = await getPreview();
            if (!preview.paragraph) throw new Error('No SCRIPTA paragraph is selected.');
            const generated = await reformulate({ roomId, paragraph: preview.paragraph, command: text });
            const generatedText = String(generated?.text || generated || '').trim();
            if (!generatedText) throw new Error('SCRIPTA AI reformulation returned no text.');
            mutation = { operation: 'p-variant-add', text: generatedText };
        }
        const targetlessOperation = ['chapter-add', 'undo'].includes(mutation.operation);
        const hasDirectTarget = Boolean(parsed.chapterId || parsed.paragraphId || targetlessOperation);
        if (!hasDirectTarget || parsed.targetChapterOrdinal) current = await getPreview();
        const ids = hasDirectTarget
            ? { chapterId: parsed.chapterId || '', paragraphId: parsed.paragraphId || '' }
            : resolveIds(current, parsed);
        const targetChapter = parsed.targetChapterOrdinal ? current.documentOutline[parsed.targetChapterOrdinal - 1] : null;
        response = await mutateScripta(context, {
            roomId, operation: mutation.operation, resourceId: parsed.resourceId, ...ids, participantId, command: text,
            variantId: mutation.variantId, variantOrdinal: mutation.variantOrdinal, type: mutation.type,
            title: mutation.title, text: mutation.text, targetChapterId: parsed.targetChapterId || targetChapter?.chapterId,
            targetIndex: parsed.targetIndex !== 0 && parsed.targetIndex ? parsed.targetIndex - 1 : parsed.targetIndex,
            authInfo,
        });
    }
    return { ...response, source: normalizedSource, ...presentation(roomId) };
}
