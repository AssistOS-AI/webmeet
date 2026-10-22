#!/bin/sh
# Shared POSIX helpers for the start and health scripts. The LiveKit UDP mux
# port is the Box media UDP port (PLOINKY_BOX_MEDIA_PORT, default 7882), so the
# ownership and forbidden-listener checks take the port as an argument.

# Succeeds when $1 is a canonical UDP port: digits only, no leading zero, 1..65535.
livekit_valid_udp_port() {
  case "${1:-}" in
    ''|0*|*[!0-9]*) return 1 ;;
  esac
  [ "${#1}" -le 5 ] && [ "$1" -le 65535 ]
}

# Prints .rtc.udp_port from a generated livekit.yaml (JSON). Only the start
# script may call this: the file holds API secrets and health never reads it.
livekit_udp_port_from_config() {
  _lk_port="$(node -e '
    const fs = require("fs");
    const rtc = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).rtc;
    const port = rtc && rtc.udp_port;
    if (typeof port === "number") process.stdout.write(String(port));
  ' "$1" 2>/dev/null)" || return 1
  livekit_valid_udp_port "$_lk_port" || return 1
  printf '%s\n' "$_lk_port"
}

# Succeeds when livekit-server owns a UDP listener on :$1.
livekit_owns_udp() {
  ss -H -lunp 2>/dev/null | awk -v port=":${1}\$" '$4 ~ port && /livekit-server/ { found=1 } END { exit(found ? 0 : 1) }'
}

# Succeeds when a forbidden local TURN or LiveKit UDP-range listener exists.
# The forbidden set is {3478, 5349, 7883..7892} minus the selected mux port.
forbidden_udp_listener_present() {
  _lk_mux="$1"
  _lk_ports=""
  for _lk_candidate in 3478 5349 7883 7884 7885 7886 7887 7888 7889 7890 7891 7892; do
    [ "$_lk_candidate" = "$_lk_mux" ] && continue
    _lk_ports="${_lk_ports:+$_lk_ports|}${_lk_candidate}"
  done
  ss -H -lun 2>/dev/null | awk -v ports="$_lk_ports" '
    BEGIN { n = split(ports, list, "|") }
    {
      for (i = 1; i <= n; i++) {
        if (substr($4, length($4) - length(list[i])) == ":" list[i]) found = 1
      }
    }
    END { exit(found ? 0 : 1) }
  '
}

# Health-side port selection. $1 is the fixed port file written by the start
# script. Sets livekit_udp_port on success; on failure sets
# LIVEKIT_UDP_PORT_ERROR and returns 1. With no port file, only a Box without
# PLOINKY_BOX_MEDIA_PORT (surrounding whitespace ignored, as in the generator)
# falls back to 7882; an exported port without the file fails closed.
livekit_check_selected_udp_port() {
  _lk_file="$1"
  LIVEKIT_UDP_PORT_ERROR=""
  if [ -e "$_lk_file" ] || [ -L "$_lk_file" ]; then
    if [ ! -f "$_lk_file" ] || [ -L "$_lk_file" ]; then
      LIVEKIT_UDP_PORT_ERROR='LiveKit UDP port file is missing or invalid'
      return 1
    fi
    if [ "$(stat -c '%u:%g:%a' "$_lk_file")" != '0:0:444' ]; then
      LIVEKIT_UDP_PORT_ERROR='LiveKit UDP port file ownership or mode is invalid'
      return 1
    fi
    livekit_udp_port="$(cat "$_lk_file")"
    if ! livekit_valid_udp_port "$livekit_udp_port"; then
      LIVEKIT_UDP_PORT_ERROR='LiveKit UDP port file is malformed'
      return 1
    fi
  elif [ -z "$(printf '%s' "${PLOINKY_BOX_MEDIA_PORT:-}" | tr -d '[:space:]')" ]; then
    livekit_udp_port=7882
  else
    LIVEKIT_UDP_PORT_ERROR='LiveKit UDP port file is missing'
    return 1
  fi
  if ! livekit_owns_udp "$livekit_udp_port"; then
    LIVEKIT_UDP_PORT_ERROR="LiveKit does not own ${livekit_udp_port}/udp"
    return 1
  fi
}
