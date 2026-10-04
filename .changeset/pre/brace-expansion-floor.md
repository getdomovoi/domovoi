---
---

Pin `brace-expansion` to its patched versions (1.1.21, 2.1.7 and 5.0.12) through scoped
overrides. Older versions carry two high advisories for unbounded recursion on crafted patterns
(GHSA-6j4f-fj2g-mc7p and GHSA-qhr7-859c-m2p7). It is reached through `minimatch` in eslint,
electron-builder and the private mobile app's Expo toolchain; no released package depends on it.
