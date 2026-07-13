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
    WEBMEET_PUBLIC_LIVEKIT_URL \
    WEBMEET_LIVEKIT_URL \
    WEBMEET_LIVEKIT_API_KEY \
    WEBMEET_LIVEKIT_API_SECRET \
    WEBMEET_ICE_TRANSPORT_POLICY \
    WEBMEET_ROOM_PREFIX \
    WEBMEET_AGENT_NAME \
    WEBMEET_DATA_DIR
do
    export_if_present "$name"
done

if [ -z "${WEBMEET_PUBLIC_LIVEKIT_URL:-}" ]; then
    printf '%s\n' 'WEBMEET_PUBLIC_LIVEKIT_URL must be provided by the Web Publishing config provider.' >&2
    exit 1
fi

if [ -z "${WEBMEET_LIVEKIT_URL:-}" ]; then
    printf '%s\n' 'WEBMEET_LIVEKIT_URL must be provided by the Web Publishing config provider.' >&2
    exit 1
fi

case "${WEBMEET_ICE_TRANSPORT_POLICY:-}" in
    all|relay) ;;
    *)
        printf '%s\n' 'WEBMEET_ICE_TRANSPORT_POLICY must be exactly "all" or "relay".' >&2
        exit 1
        ;;
esac

mkdir -p "${WEBMEET_DATA_DIR:-/data}"
chmod +x /code/tools/webmeet_tool.sh /code/tools/webmeet_tool.mjs 2>/dev/null || true

exec sh /Agent/server/AgentServer.sh
