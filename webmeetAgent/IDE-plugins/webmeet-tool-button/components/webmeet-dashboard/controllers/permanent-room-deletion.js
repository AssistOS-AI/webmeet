export async function applyPermanentRoomDeletion(controller, meeting, result, runTool) {
    if (result?.delete !== true || result?.confirmed !== true) {
        return false;
    }
    const roomId = String(meeting?.id || '').trim();
    if (!roomId || String(result?.roomId || '').trim() !== roomId) {
        throw new Error('Delete room confirmation does not match the selected room.');
    }
    if (typeof runTool !== 'function') {
        throw new Error('Delete room tool is unavailable.');
    }

    const activeRoomId = String(controller.state?.session?.meeting?.id || '').trim();
    if (activeRoomId === roomId && typeof controller.unjoinCurrentSession === 'function') {
        await controller.unjoinCurrentSession({
            preserveDisplayName: false,
            manageTransition: false
        });
    }

    const deletion = await runTool('webmeet_room_delete', {
        roomId,
        confirmed: true
    });
    if (deletion?.deleted !== true || String(deletion?.roomId || '').trim() !== roomId) {
        throw new Error('Delete room did not return a matching deletion result.');
    }

    controller.clearMeetingGetCache?.(roomId);
    await controller.loadMeetings();
    if (controller.state?.meetings?.some((entry) => String(entry?.id || '').trim() === roomId)) {
        throw new Error('Deleted room is still present in the refreshed room list.');
    }
    controller.renderAll();
    controller.setError('Room deleted permanently.');
    return true;
}
