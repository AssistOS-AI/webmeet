# RNNoise WASM Vendor Copy

This directory contains the local WebMeet vendor copy of `@shiguredo/rnnoise-wasm`.

WebMeet uses it only for browser-side enhanced microphone processing. The library is loaded from local plugin assets and must not be fetched from a CDN at runtime.

## Source

- Package: `@shiguredo/rnnoise-wasm`
- Version: `2025.1.5`
- Repository: https://github.com/shiguredo/rnnoise-wasm
- npm tarball: https://registry.npmjs.org/@shiguredo/rnnoise-wasm/-/rnnoise-wasm-2025.1.5.tgz
- License: Apache-2.0

See `THIRD_PARTY_NOTICES.md` for the exact npm integrity value and vendored file mapping.

## Files

- `rnnoise.js`: browser ESM build with embedded WASM payload. Upstream non-English JSDoc comments were removed; executable code is unchanged.
- `LICENSE`: upstream Apache-2.0 license file.
- `package.json`: upstream package metadata.
- `THIRD_PARTY_NOTICES.md`: local provenance and usage notes.

The upstream package README is not copied verbatim here because this repository keeps vendor documentation in English and tracks provenance through the notice file.
