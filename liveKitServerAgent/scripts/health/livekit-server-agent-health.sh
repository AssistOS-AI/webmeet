#!/bin/sh
set -eu

fail() {
  printf '[health] %s\n' "$1" >&2
  exit 1
}

EGRESS_PID_FILE="/run/ploinky/egress.pid"
LIVEKIT_UDP_PORT_FILE="/run/ploinky/livekit-udp-port"

# shellcheck source=../lib/livekit-udp-mux.sh
. /code/scripts/lib/livekit-udp-mux.sh

curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:17000/ready \
  || fail 'private supervisor readiness failed'
[ "$(redis-cli -h 127.0.0.1 -p 6379 ping 2>/dev/null)" = "PONG" ] \
  || fail 'Redis semantic PING failed'
curl -fsS --max-time 2 -o /dev/null http://127.0.0.1:7880/ \
  || fail 'LiveKit signaling health failed'
node /code/scripts/health/egress-semantic-health.mjs \
  || fail 'Egress semantic health/template probes failed'

[ -f "$EGRESS_PID_FILE" ] && [ ! -L "$EGRESS_PID_FILE" ] \
  || fail 'Egress pid file is missing or invalid'
[ "$(stat -c '%u:%g:%a' "$EGRESS_PID_FILE")" = '0:0:444' ] \
  || fail 'Egress pid file ownership or mode is invalid'
egress_pid="$(cat "$EGRESS_PID_FILE")"
case "$egress_pid" in
  *[!0-9]*|'') fail 'Egress pid file is malformed' ;;
esac
egress_uid="$(id -u egress 2>/dev/null)" \
  || fail 'Egress runtime user is missing'
kill -0 "$egress_pid" 2>/dev/null \
  || fail 'supervised Egress process is not running'

for port in 7980 7981; do
  ss -H -lntpe 2>/dev/null | awk -v port=":${port}$" -v uid="$egress_uid" '
    $4 ~ port && index($0, "uid:" uid) { found=1 }
    END { exit(found ? 0 : 1) }
  ' || fail "Egress TCP $port is not owned by the unprivileged egress user"
  ss -H -lnt 2>/dev/null | awk -v port=":${port}$" '
    $4 ~ port && ($4 ~ /^127\.0\.0\.1:/ || $4 ~ /^\[::1\]:/) { found=1 }
    END { exit(found ? 0 : 1) }
  ' || fail "Egress TCP $port is not loopback-bound"
  if ss -H -lnt 2>/dev/null | awk -v port=":${port}$" '
    $4 ~ port && !($4 ~ /^127\.0\.0\.1:/ || $4 ~ /^\[::1\]:/) { found=1 }
    END { exit(found ? 0 : 1) }
  '; then
    fail "Egress TCP $port has a non-loopback listener"
  fi
done

# The start script publishes the selected mux port once LiveKit owns it. Health
# never reads the generated LiveKit config because it holds API secrets. Without the
# file, only a Box on the default media port (no PLOINKY_BOX_MEDIA_PORT) falls
# back to 7882; an exported port without the file fails closed.
if [ -e "$LIVEKIT_UDP_PORT_FILE" ] || [ -L "$LIVEKIT_UDP_PORT_FILE" ]; then
  [ -f "$LIVEKIT_UDP_PORT_FILE" ] && [ ! -L "$LIVEKIT_UDP_PORT_FILE" ] \
    || fail 'LiveKit UDP port file is missing or invalid'
  [ "$(stat -c '%u:%g:%a' "$LIVEKIT_UDP_PORT_FILE")" = '0:0:444' ] \
    || fail 'LiveKit UDP port file ownership or mode is invalid'
  livekit_udp_port="$(cat "$LIVEKIT_UDP_PORT_FILE")"
  livekit_valid_udp_port "$livekit_udp_port" \
    || fail 'LiveKit UDP port file is malformed'
elif [ -z "${PLOINKY_BOX_MEDIA_PORT:-}" ]; then
  livekit_udp_port=7882
else
  fail 'LiveKit UDP port file is missing'
fi
livekit_owns_udp "$livekit_udp_port" \
  || fail "LiveKit does not own ${livekit_udp_port}/udp"

if ss -H -lnt 2>/dev/null | awk '$4 ~ /:(80|443|3478|5349|7881)$/ { found=1 } END { exit(found ? 0 : 1) }'; then
  fail 'forbidden TCP listener detected'
fi
if forbidden_udp_listener_present "$livekit_udp_port"; then
  fail 'forbidden UDP listener detected'
fi

printf 'ok\n'
