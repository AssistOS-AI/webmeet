import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('background effects use the WebMeet asset route for MediaPipe wasm assets', async () => {
    const source = await fs.readFile(
        path.resolve(
            import.meta.dirname,
            '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard-modal/services/livekit-loader.js'
        ),
        'utf8'
    );

    assert.match(source, /\/public-services\/webmeet\/assets\//);
    assert.match(source, /vendor\/background-effects\/wasm\//);
    assert.match(source, /vendor\/background-effects\/models\/selfie_segmenter\.tflite/);
});
