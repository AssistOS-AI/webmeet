import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { EncryptedSessionJournal } from '../lib/encrypted-journal.mjs';

test('session journals are encrypted at rest and can be removed', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-scribe-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const journal = new EncryptedSessionJournal({ dataDir, secret: 'unit-test-secret' });
    const state = { segments: [{ text: 'confidential meeting sentence' }] };

    await journal.save('notes_session_1234', state);
    const stored = await fs.readFile(journal.filePath('notes_session_1234'), 'utf8');
    assert.doesNotMatch(stored, /confidential meeting sentence/);
    assert.deepEqual(await journal.load('notes_session_1234'), state);

    await journal.remove('notes_session_1234');
    assert.equal(await journal.load('notes_session_1234'), null);
});

test('concurrent journal saves are serialized in invocation order', async (t) => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-scribe-order-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const journal = new EncryptedSessionJournal({ dataDir, secret: 'unit-test-secret' });

    const first = journal.save('notes_session_order', { revision: 1 });
    const second = journal.save('notes_session_order', { revision: 2 });
    await Promise.all([first, second]);

    assert.deepEqual(await journal.load('notes_session_order'), { revision: 2 });
});
