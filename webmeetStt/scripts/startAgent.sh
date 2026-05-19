#!/bin/sh

set -eu

mkdir -p /data/models

python -m pip install --no-cache-dir --disable-pip-version-check \
    fastapi==0.124.0 \
    uvicorn==0.38.0 \
    python-multipart==0.0.20 \
    faster-whisper==1.2.1 \
    livekit-plugins-dtln==0.1.0 >/tmp/webmeet-stt-pip.out 2>/tmp/webmeet-stt-pip.err

exec python /code/server.py
