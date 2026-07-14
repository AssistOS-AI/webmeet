#!/bin/sh
# Runs inside the private webmeetStt container for direct-start readiness and
# watchdog health checks. Explorer launches STT no-wait, so this probe does not
# gate Explorer startup or require publishing the listener across the box boundary.
set -u

HOST="127.0.0.1"
PORT="${WEBMEET_STT_PORT:-9000}"

log() {
    printf '[webmeetStt readiness] %s\n' "$1"
}

PYTHON_BIN="python"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    PYTHON_BIN="python3"
fi
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    log "ERROR: pinned image is missing Python."
    exit 1
fi

if ! "$PYTHON_BIN" - "$HOST" "$PORT" <<'PY'
import http.client
import sys

host = sys.argv[1]
try:
    port = int(sys.argv[2])
except ValueError:
    raise SystemExit(1)

if port < 1 or port > 65535:
    raise SystemExit(1)

connection = http.client.HTTPConnection(host, port, timeout=3)
try:
    connection.request("GET", "/healthz")
    response = connection.getresponse()
    response.read(4096)
    if response.status != 200:
        raise SystemExit(1)
except (OSError, http.client.HTTPException):
    raise SystemExit(1)
finally:
    connection.close()
PY
then
    log "ERROR: /healthz is not ready on ${HOST}:${PORT}."
    exit 1
fi

log "ready"
