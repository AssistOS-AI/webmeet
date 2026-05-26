#!/usr/bin/env bash
set -euo pipefail

profile="${PLOINKY_PROFILE:-default}"

case "$profile" in
    default)
        livekit_port=7880
        ;;
    dev)
        livekit_port=17880
        ;;
    *)
        exit 0
        ;;
esac

is_ipv4() {
    printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

is_loopback_host() {
    case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        ''|localhost|127.*|::1|'[::1]')
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

host_from_url() {
    printf '%s' "${1:-}" \
        | sed -E 's#^[A-Za-z][A-Za-z0-9+.-]*://##; s#/.*$##; s#^\[([^]]+)\].*$#\1#; s#:([0-9]+)$##'
}

is_loopback_url() {
    is_loopback_host "$(host_from_url "$1")"
}

detect_local_public_host() {
    override="${WEBMEET_LOCAL_PUBLIC_HOST:-}"
    if [ -n "$override" ] && [ "$override" != "auto" ]; then
        printf '%s\n' "$override"
        return 0
    fi

    if command -v route >/dev/null 2>&1 && command -v ipconfig >/dev/null 2>&1; then
        iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2; exit}')"
        if [ -n "$iface" ]; then
            candidate="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
            if is_ipv4 "$candidate" && ! is_loopback_host "$candidate"; then
                printf '%s\n' "$candidate"
                return 0
            fi
        fi
    fi

    if command -v ipconfig >/dev/null 2>&1; then
        for iface in en0 en1; do
            candidate="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
            if is_ipv4 "$candidate" && ! is_loopback_host "$candidate"; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi

    if command -v ip >/dev/null 2>&1; then
        candidate="$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
        if is_ipv4 "$candidate" && ! is_loopback_host "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    fi

    if command -v hostname >/dev/null 2>&1; then
        for candidate in $(hostname -I 2>/dev/null || true); do
            if is_ipv4 "$candidate" && ! is_loopback_host "$candidate"; then
                printf '%s\n' "$candidate"
                return 0
            fi
        done
    fi

    return 1
}

set_workspace_var() {
    name="$1"
    value="$2"
    if command -v ploinky >/dev/null 2>&1; then
        ploinky var "$name" "$value" >/dev/null
    fi
}

host="$(detect_local_public_host || true)"
if [ -z "$host" ]; then
    exit 0
fi

current_livekit_url="${WEBMEET_PUBLIC_LIVEKIT_URL:-}"
if [ -z "$current_livekit_url" ] || is_loopback_url "$current_livekit_url"; then
    set_workspace_var WEBMEET_PUBLIC_LIVEKIT_URL "ws://${host}:${livekit_port}"
fi

current_turn_external_ip="${WEBMEET_TURN_EXTERNAL_IP:-}"
if [ -z "$current_turn_external_ip" ] || is_loopback_host "$current_turn_external_ip"; then
    set_workspace_var WEBMEET_TURN_EXTERNAL_IP "$host"
fi

current_turn_host="${WEBMEET_TURN_HOST:-}"
if [ -z "$current_turn_host" ] || is_loopback_host "$current_turn_host"; then
    set_workspace_var WEBMEET_TURN_HOST "$host"
fi
