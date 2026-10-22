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
