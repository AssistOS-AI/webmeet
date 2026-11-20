import test from 'node:test';
import assert from 'node:assert/strict';
import { appendChatText, chatTextSegments } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/chat-message-text.js';
import { renderChatFeed } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/controllers/dashboard-render-methods.js';

test('chat URLs become safe links without losing punctuation or message text', () => {
    const text = 'Vezi https://example.com/path?q=1&x=2, apoi (http://localhost:8080/app). www.example.org/test';
    const segments = chatTextSegments(text);
    assert.equal(segments.map((segment) => segment.value).join(''), text);
    assert.deepEqual(segments.filter((segment) => segment.type === 'link').map((segment) => segment.href), [
        'https://example.com/path?q=1&x=2', 'http://localhost:8080/app', 'https://www.example.org/test'
    ]);
    assert.equal(chatTextSegments('javascript:alert(1) data:text/html,<script>x</script>').some((segment) => segment.type === 'link'), false);
});

test('chat URL parsing preserves balanced parentheses and file mentions', () => {
    const text = '@file:notes.md https://example.com/wiki/Topic_(detail). @unknown';
    const segments = chatTextSegments(text, ['@file:notes.md']);
    assert.equal(segments.find((segment) => segment.type === 'mention').value, '@file:notes.md');
    assert.equal(segments.find((segment) => segment.type === 'link').value, 'https://example.com/wiki/Topic_(detail)');
    assert.equal(segments.map((segment) => segment.value).join(''), text);
});

function fixture(t) {
    let selection = null;
    const document = {
        createElement: (tag) => new Node(tag),
        createTextNode: (value) => Object.assign(new Node('#text'), { textContent: value }),
        getSelection: () => selection
    };
    class Node {
        constructor(tag) {
            this.tag = tag;
            this.childNodes = [];
            this.parentNode = null;
            this.ownerDocument = document;
            this.classList = { toggle() {} };
        }
        append(node) { this.insertBefore(node, null); }
        insertBefore(node, before) {
            node.remove();
            const index = before ? this.childNodes.indexOf(before) : this.childNodes.length;
            this.childNodes.splice(index, 0, node);
            node.parentNode = this;
        }
        remove() {
            if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
            this.parentNode = null;
        }
        contains(node) { return node === this || this.childNodes.some((child) => child.contains(node)); }
        querySelector(selector) { return this.fields?.[selector] || null; }
    }
    const original = globalThis.document;
    globalThis.document = document;
    t.after(() => { globalThis.document = original; });
    let clones = 0;
    const owner = { element: { querySelector: () => ({ content: { cloneNode: () => ({ querySelector: () => {
        clones += 1;
        const item = new Node('article');
        item.fields = {};
        for (const key of ['.webmeet-chat-entry', '[data-role="chat-author"]', '[data-role="chat-time"]', '[data-role="chat-event-status"]', '[data-role="chat-text"]']) {
            const child = new Node('div');
            item.fields[key] = child;
            item.append(child);
        }
        return item;
    } }) } }) } };
    const target = Object.assign(new Node('div'), { scrollTop: 0, scrollHeight: 1000, clientHeight: 200 });
    return { owner, target, document, clones: () => clones, select(node) { selection = { isCollapsed: false, anchorNode: node, focusNode: node }; } };
}

test('rendered links use text nodes and keep normal browser navigation', (t) => {
    const { document } = fixture(t);
    const container = document.createElement('div');
    appendChatText(container, '<img onerror=alert(1)> https://example.com/', []);
    assert.equal(container.childNodes[0].tag, '#text');
    const link = container.childNodes[1];
    assert.equal(link.tag, 'a');
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
    assert.equal(link.href, 'https://example.com/');
});

test('participant refreshes and incoming messages preserve selected chat DOM and scroll', (t) => {
    const f = fixture(t);
    const first = { id: '1', message: 'Copy this https://example.com', authorId: 'user', createdAt: '2026-11-20T12:00:00Z' };
    const options = { knownTokens: [], participantId: 'user', emptyMessage: 'Empty' };
    renderChatFeed(f.owner, f.target, [first], options);
    const node = f.target.childNodes[0];
    const selectedText = node.fields['[data-role="chat-text"]'].childNodes[0];
    f.select(selectedText);
    f.target.scrollTop = 100;
    renderChatFeed(f.owner, f.target, [{ ...first }], options);
    assert.equal(f.clones(), 1);
    assert.equal(f.target.childNodes[0], node);
    assert.equal(f.target.contains(selectedText), true);
    renderChatFeed(f.owner, f.target, [first, { ...first, id: '2', message: 'New message' }], options);
    assert.equal(f.target.childNodes[0], node);
    assert.equal(f.target.scrollTop, 100);
    renderChatFeed(f.owner, f.target, [{ ...first, id: '0' }, first, { ...first, id: '2', message: 'New message' }], options);
    assert.equal(f.target.childNodes[1], node);
    assert.equal(f.target.contains(selectedText), true);
});

test('chat edits update the affected entry without replacing other messages', (t) => {
    const f = fixture(t);
    const entries = [{ id: '1', message: 'First' }, { id: '2', message: 'Second' }];
    renderChatFeed(f.owner, f.target, entries);
    const second = f.target.childNodes[1];
    renderChatFeed(f.owner, f.target, [{ ...entries[0], message: 'Edited' }, entries[1]]);
    assert.equal(f.target.childNodes[1], second);
    assert.equal(f.target.childNodes[0].fields['[data-role="chat-text"]'].childNodes[0].textContent, 'Edited');
});
