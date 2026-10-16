# Third-Party Notice: RNNoise WASM

This directory vendors the RNNoise WebAssembly package used by WebMeet enhanced voice processing.

## Package

- Package: `@jitsi/rnnoise-wasm`
- Version: `0.2.1`
- Source repository: https://github.com/jitsi/rnnoise-wasm
- npm tarball: https://registry.npmjs.org/@jitsi/rnnoise-wasm/-/rnnoise-wasm-0.2.1.tgz
- npm integrity: `sha512-iEj77www43pS2Yq+cfLZb+hFuI7L5ccisBzzPMcOjjLsG4/LAlkD1CY58/8gc84nHdLBGmD/OPIWGnvYnXvB0A==`
- License: Apache-2.0

## Vendored Files

- `rnnoise-sync.js`: copied from package file `dist/rnnoise-sync.js`.
- `LICENSE`: copied from package file `LICENSE`.
- `package.json`: copied from package file `package.json`, with local `type: module` added so tooling treats `rnnoise-sync.js` as ESM.

## Runtime Boundary

WebMeet loads this library only from local plugin assets. It must not fetch RNNoise code or WASM from a CDN at runtime.

The synchronous Jitsi build is used because WebMeet runs RNNoise inside `AudioWorklet`, and this package explicitly provides `rnnoise-sync.js` for that kind of runtime.
