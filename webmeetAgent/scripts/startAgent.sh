#!/bin/sh

set -eu

find_workspace_root() {
    current="$1"
    while [ -n "$current" ] && [ "$current" != "/" ]; do
        if [ -d "$current/.ploinky" ]; then
            printf '%s\n' "$current"
            return 0
        fi
        parent="$(dirname "$current")"
        if [ "$parent" = "$current" ]; then
            break
        fi
        current="$parent"
    done
    printf '%s\n' "$1"
}

WORKSPACE_HINT="${PLOINKY_WORKSPACE_ROOT:-${WORKSPACE_ROOT:-${PLOINKY_CWD:-${ASSISTOS_FS_ROOT:-$(pwd)}}}}"
WORKSPACE_DIR="$(find_workspace_root "$WORKSPACE_HINT")"

export_if_present() {
    var_name="$1"
    eval "current_value=\${$var_name-}"
    if [ -n "${current_value:-}" ]; then
        export "$var_name=$current_value"
    fi
}

for name in \
    LLMAgentClient_DEBUG \
    LLMAgentClient_VERBOSE_DELAY \
    PLOINKY_WEBMEET_MASTER_KEY \
    SOUL_GATEWAY_API_KEY \
    WEBMEET_PUBLIC_LIVEKIT_URL \
    WEBMEET_LIVEKIT_URL \
    WEBMEET_LIVEKIT_API_KEY \
    WEBMEET_LIVEKIT_API_SECRET \
    WEBMEET_EGRESS_URL \
    WEBMEET_TURN_EXTERNAL_IP \
    WEBMEET_TURN_PORT \
    WEBMEET_TURN_URLS \
    WEBMEET_TURN_REALM \
    WEBMEET_TURN_USER \
    WEBMEET_TURN_PASSWORD \
    WEBMEET_ICE_TRANSPORT_POLICY \
    WEBMEET_TURN_MIN_PORT \
    WEBMEET_TURN_MAX_PORT \
    WEBMEET_ROOM_PREFIX \
    WEBMEET_AGENT_NAME \
    WEBMEET_DATA_DIR \
    WEBMEET_RECORDINGS_DIR \
    WEBMEET_API_PORT \
    WEBMEET_WORKER_POLL_MS
do
    export_if_present "$name"
done

mkdir -p "${WEBMEET_DATA_DIR:-/data}"
chmod +x /code/tools/webmeet_tool.sh /code/tools/webmeet_tool.mjs 2>/dev/null || true

node /code/server/webmeet-api.mjs >/tmp/webmeet-api.out 2>/tmp/webmeet-api.err &
node /code/server/webmeet-worker.mjs >/tmp/webmeet-worker.out 2>/tmp/webmeet-worker.err &
PORT="${WEBMEET_MCP_PORT:-7001}" sh /Agent/server/AgentServer.sh >/tmp/webmeet-mcp.out 2>/tmp/webmeet-mcp.err &

exec node /code/server/webmeet-public-proxy.mjs
