import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getWorkspacePaths } from '../../lib/workspacePaths.mjs';

test('WebMeet requires WEBMEET_DATA_DIR instead of deriving a private fallback', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webmeet-workspace-paths-'));
    await fs.mkdir(path.join(root, '.ploinky'), { recursive: true });
    const previousWorkspace = process.env.PLOINKY_WORKSPACE_ROOT;
    const previousData = process.env.WEBMEET_DATA_DIR;
    try {
        process.env.PLOINKY_WORKSPACE_ROOT = root;
        delete process.env.WEBMEET_DATA_DIR;
        assert.throws(() => getWorkspacePaths(), /WEBMEET_DATA_DIR is required/);

        const dataRoot = path.join(root, '.data', 'webmeetAgent', 'data');
        process.env.WEBMEET_DATA_DIR = dataRoot;
        assert.equal(getWorkspacePaths().webmeetDir, dataRoot);
    } finally {
        if (previousWorkspace === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previousWorkspace;
        if (previousData === undefined) delete process.env.WEBMEET_DATA_DIR;
        else process.env.WEBMEET_DATA_DIR = previousData;
        await fs.rm(root, { recursive: true, force: true });
    }
});
