import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { dashboardChromeMethods } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-chrome-methods.js';

const dashboardHtmlUrl = new URL(
    '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/webmeet-dashboard.html',
    import.meta.url
);
const chatComponentUrl = new URL(
    '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/service-components/chat-component.js',
    import.meta.url
);

test('chat add control declares reusable menu structure and WebSkel actions in HTML', async () => {
    const [html, chatSource] = await Promise.all([
        fs.readFile(dashboardHtmlUrl, 'utf8'),
        fs.readFile(chatComponentUrl, 'utf8'),
    ]);

    assert.match(html, /id="webmeetChatImageButton"[\s\S]*data-local-action="toggleChatAddMenu"/);
    assert.match(html, /id="webmeetChatAddMenu"[\s\S]*role="menu"[\s\S]*hidden/);
    assert.match(html, /data-local-action="selectChatAddImage"[\s\S]*<span>Add image<\/span>/);
    assert.match(html, /webmeet-chat-add-control[\s\S]*webmeet-chat-input-shell[\s\S]*webmeet-compose-actions/);
    assert.match(html, /id="webmeetChatComposer"[\s\S]*id="webmeetChatDropOverlay"[\s\S]*Drop images to upload/);
    assert.doesNotMatch(chatSource, /button\.addEventListener\(['"]click['"]/);
    assert.doesNotMatch(chatSource, /createElement\(['"]div['"]\)[\s\S]*webmeet-chat-input-shell/);
});

test('chat add presenter actions project menu state and open the image picker', () => {
    let optionFocusCount = 0;
    let pickerClickCount = 0;
    const attributes = new Map();
    const dashboard = Object.assign({}, dashboardChromeMethods, {
        state: { chatAddMenuVisible: false },
        chatAddMenu: { hidden: true },
        chatImageButton: {
            setAttribute: (name, value) => attributes.set(name, value),
            focus() {},
        },
        chatAddImageOption: { focus: () => { optionFocusCount += 1; } },
        chatImageInput: { click: () => { pickerClickCount += 1; } },
    });

    dashboard.toggleChatAddMenu();
    assert.equal(dashboard.chatAddMenu.hidden, false);
    assert.equal(attributes.get('aria-expanded'), 'true');
    assert.equal(optionFocusCount, 1);

    dashboard.selectChatAddImage();
    assert.equal(dashboard.chatAddMenu.hidden, true);
    assert.equal(attributes.get('aria-expanded'), 'false');
    assert.equal(pickerClickCount, 1);
});
