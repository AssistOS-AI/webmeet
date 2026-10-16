# Meyda vendor copy

WebMeet uses this pinned browser bundle for local voice-expression feature extraction. It is loaded only from the plugin's local assets; no CDN or runtime package resolution is used.

- Package: `meyda`
- Version: `5.6.3`
- Source: https://github.com/meyda/meyda
- License: MIT
- Browser entry: `dist/meyda.min.js`

Updates must replace the bundle from the pinned npm tarball, update the integrity value in `THIRD_PARTY_NOTICES.md`, retain the upstream license, and rerun the vendor and avatar-expression tests.
