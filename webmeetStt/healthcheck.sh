#!/bin/sh
set -eu

if command -v python >/dev/null 2>&1; then
    python_bin=python
else
    python_bin=python3
fi

"$python_bin" - <<'PY'
import os
import urllib.request

port = int(os.environ.get("WEBMEET_STT_PORT", "9000"))
with urllib.request.urlopen(f"http://127.0.0.1:{port}/healthz", timeout=2) as response:
    if response.status != 200:
        raise SystemExit(1)
PY
