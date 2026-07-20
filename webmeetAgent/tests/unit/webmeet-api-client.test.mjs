import test from 'node:test';
import assert from 'node:assert/strict';

import { runWebMeetTool, WebMeetToolError } from '../../IDE-plugins/webmeet-tool-button/components/webmeet-dashboard/services/webmeet-api-client.js';

test('WebMeet API client preserves structured tool error messages and codes', async () => {
    const previousWindow = globalThis.window;
    globalThis.window = {
        webSkel: {
            appServices: {
                getClient() {
                    return {
                        async callTool() {
                            return {
                                content: [{
                                    type: 'text',
                                    text: JSON.stringify({
                                        ok: false,
                                        error: {
                                            code: 'version_conflict',
                                            message: 'Blackboard version conflict: expected 4, current 5.',
                                            currentBoardVersion: 5
                                        }
                                    })
                                }]
                            };
                        }
                    };
                }
            }
        }
    };
    try {
        await assert.rejects(
            () => runWebMeetTool('webmeet_event_command', {}),
            (error) => {
                assert.ok(error instanceof WebMeetToolError);
                assert.equal(error.code, 'version_conflict');
                assert.equal(error.message, 'Blackboard version conflict: expected 4, current 5.');
                assert.equal(error.data.error.currentBoardVersion, 5);
                return true;
            }
        );
    } finally {
        if (previousWindow === undefined) delete globalThis.window;
        else globalThis.window = previousWindow;
    }
});
