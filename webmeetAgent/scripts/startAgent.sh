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
SECRETS_FILE="$WORKSPACE_DIR/.ploinky/.secrets"

read_kv_file_value() {
    var_name="$1"
    file_path="$2"
    [ -f "$file_path" ] || return 0
    awk -F= -v key="$var_name" '
        $0 !~ /^[[:space:]]*#/ && $1 == key {
            sub(/^[^=]*=/, "", $0)
            print $0
            exit
        }
    ' "$file_path"
}

export_with_fallback() {
    var_name="$1"
    eval "current_value=\${$var_name-}"
    if [ -n "${current_value:-}" ]; then
        export "$var_name=$current_value"
        return 0
    fi

    secret_value="$(read_kv_file_value "$var_name" "$SECRETS_FILE")"
    if [ -n "${secret_value:-}" ]; then
        export "$var_name=$secret_value"
        return 0
    fi
}

for name in \
    OPENAI_API_KEY \
    ANTHROPIC_API_KEY \
    GEMINI_API_KEY \
    MISTRAL_API_KEY \
    DEEPSEEK_API_KEY \
    OPENROUTER_API_KEY \
    HUGGINGFACE_API_KEY \
    XAI_API_KEY \
    AXIOLOGIC_API_KEY \
    OPENCODE_API_KEY \
    AXIOLOGIC_PROXY_API_KEY \
    LLMAgentClient_DEBUG \
    LLMAgentClient_VERBOSE_DELAY \
    SOUL_GATEWAY_API_KEY \
    WEBMEET_PUBLIC_LIVEKIT_URL \
    WEBMEET_LIVEKIT_URL \
    WEBMEET_LIVEKIT_API_KEY \
    WEBMEET_LIVEKIT_API_SECRET \
    WEBMEET_EGRESS_URL \
    WEBMEET_ROOM_PREFIX \
    WEBMEET_AGENT_NAME \
    WEBMEET_DATA_DIR \
    WEBMEET_RECORDINGS_DIR \
    WEBMEET_API_PORT \
    WEBMEET_WORKER_POLL_MS
do
    export_with_fallback "$name"
done

mkdir -p "${WEBMEET_DATA_DIR:-/data}"
chmod +x /code/tools/webmeet_tool.sh /code/tools/webmeet_tool.mjs 2>/dev/null || true

node /code/server/webmeet-api.mjs >/tmp/webmeet-api.out 2>/tmp/webmeet-api.err &
node /code/server/webmeet-worker.mjs >/tmp/webmeet-worker.out 2>/tmp/webmeet-worker.err &

exec sh /Agent/server/AgentServer.sh
