# Third-Party Notice: RNNoise WASM

This directory vendors the browser RNNoise WebAssembly package used by WebMeet enhanced voice processing.

## Package

- Package: `@shiguredo/rnnoise-wasm`
- Version: `2025.1.5`
- Source repository: https://github.com/shiguredo/rnnoise-wasm
- npm tarball: https://registry.npmjs.org/@shiguredo/rnnoise-wasm/-/rnnoise-wasm-2025.1.5.tgz
- npm integrity: `sha512-9YJxzzHftlW936E5z9aEKK2CrPfUgc3HgZ2keyQ5e2Pb5bx+6tykYQ2Gyudvxd7Sxmlnar7SemDMFfx0OuVuGA==`
- License: Apache-2.0

## Vendored Files

- `rnnoise.js`: based on package file `dist/rnnoise.js`; upstream non-English JSDoc comments were removed to keep repository documentation English-only.
- `LICENSE`: copied from package file `LICENSE`.
- `README.md`: copied from package file `README.md`.
- `package.json`: copied from package file `package.json`.

The 2025 package embeds the WebAssembly payload in `rnnoise.js`, so WebMeet does not vendor separate `.wasm` files for this library.

## Runtime Boundary

WebMeet loads this library only from local plugin assets. It must not fetch RNNoise code or WASM from a CDN at runtime.
