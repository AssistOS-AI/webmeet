# RNNoise WASM Vendor Copy

This directory contains the local WebMeet vendor copy of `@jitsi/rnnoise-wasm`.

WebMeet uses the synchronous RNNoise build for browser-side enhanced microphone processing inside an `AudioWorklet`. The library is loaded from local plugin assets and must not be fetched from a CDN at runtime.

## Source

- Package: `@jitsi/rnnoise-wasm`
- Version: `0.2.1`
- Repository: https://github.com/jitsi/rnnoise-wasm
- npm tarball: https://registry.npmjs.org/@jitsi/rnnoise-wasm/-/rnnoise-wasm-0.2.1.tgz
- License: Apache-2.0

See `THIRD_PARTY_NOTICES.md` for the exact npm integrity value and vendored file mapping.

## Files

- `rnnoise-sync.js`: synchronous Emscripten build with embedded WASM payload, used by the audio worklet.
- `LICENSE`: upstream Apache-2.0 license file.
- `package.json`: upstream package metadata with local ESM type metadata.
- `THIRD_PARTY_NOTICES.md`: local provenance and usage notes.

The Jitsi sync build is used because it is designed for contexts such as `AudioWorklet`, where asynchronous external WASM loading is fragile or unavailable.
