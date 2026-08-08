#!/bin/sh

set -eu

mkdir -p /data/models

venv_dir=/data/python-env
venv_stamp="${venv_dir}/.webmeet-stt-dependencies"
dependencies_revision=python3.12-fastapi0.124.0-uvicorn0.38.0-multipart0.0.20-whisper1.2.1-dtln0.1.0-v1

if [ ! -x "${venv_dir}/bin/python" ] \
    || [ "$(cat "${venv_stamp}" 2>/dev/null || true)" != "${dependencies_revision}" ]; then
    candidate_dir="${venv_dir}.candidate"
    rm -rf "${candidate_dir}"
    python -m venv "${candidate_dir}"

    installed=0
    for attempt in 1 2 3; do
        echo "[webmeet-stt] Installing pinned Python dependencies (attempt ${attempt}/3)..."
        if "${candidate_dir}/bin/python" -m pip install --no-cache-dir --disable-pip-version-check \
            fastapi==0.124.0 \
            uvicorn==0.38.0 \
            python-multipart==0.0.20 \
            faster-whisper==1.2.1 \
            livekit-plugins-dtln==0.1.0; then
            installed=1
            break
        fi
        echo "[webmeet-stt] Dependency installation attempt ${attempt}/3 failed." >&2
        sleep "${attempt}"
    done

    if [ "${installed}" != "1" ]; then
        echo "[webmeet-stt] Pinned Python dependencies could not be installed after 3 attempts." >&2
        rm -rf "${candidate_dir}"
        exit 1
    fi

    printf '%s\n' "${dependencies_revision}" > "${candidate_dir}/.webmeet-stt-dependencies"
    rm -rf "${venv_dir}"
    mv "${candidate_dir}" "${venv_dir}"
fi

exec "${venv_dir}/bin/python" /code/server.py
