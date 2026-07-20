import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { filterChatEntries, formatChatEntryMessage } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js';

const dashboardHtml = fs.readFileSync(new URL('../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html', import.meta.url), 'utf8');
const dashboardCss = fs.readFileSync(new URL('../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.css', import.meta.url), 'utf8');

const messages = [
    { id: '1', kind: 'user', message: 'hello' },
    { id: '2', kind: 'event', message: '/robo focus paragraph' },
    { id: '3', kind: 'user', message: 'continue' }
];

test('Normal chat contains only participant discussion', () => {
    assert.deepEqual(filterChatEntries(messages, 'normal').map((entry) => entry.id), ['1', '3']);
});

test('Chat view defaults to Normal and exposes one Full switch', () => {
    assert.match(dashboardHtml, /class="webmeet-chat-view-mode-label">Full<\/span>/);
    assert.match(dashboardHtml, /id="webmeetChatViewMode"[\s\S]*type="checkbox"[\s\S]*role="switch"/);
    assert.doesNotMatch(dashboardHtml, /<input(?=[^>]*id="webmeetChatViewMode")[^>]*checked/);
    assert.doesNotMatch(dashboardHtml, /type="radio"/);
    assert.doesNotMatch(dashboardHtml, /<select[^>]*webmeetChatViewMode/);
    assert.doesNotMatch(dashboardHtml, /value="debug"/);
    assert.match(dashboardCss, /\.webmeet-chat-view-mode-input:checked \+ \.webmeet-chat-view-mode-track::after[\s\S]*transform:\s*translateX\(12px\)/);
    assert.match(dashboardCss, /#webmeetChatSidebar \.webmeet-panel-header \.webmeet-chat-view-mode-label[\s\S]*font-size:\s*0\.64rem;[\s\S]*text-transform:\s*none;/);
});

test('Full chat preserves the combined message order', () => {
    assert.deepEqual(filterChatEntries(messages, 'full').map((entry) => entry.id), ['1', '2', '3']);
});

test('Full event rendering hides transport metadata and opaque identifiers', () => {
    const entry = {
        kind: 'event',
        message: '/event raw',
        metadata: { event: {
            eventId: 'event-secret', commandId: 'command-secret', expectedBoardVersion: 108,
            target: { type: 'widget', boardId: 'board-secret', widgetId: 'widget-secret' },
            action: 'scripta-document-delete',
            payload: { resourceId: 'resource-secret', confirmed: true }
        } }
    };
    assert.equal(formatChatEntryMessage(entry), '/event scripta-document-delete {"confirmed":true}');
});
