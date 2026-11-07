---
---

Lock `undici` 7.29.1 in place of 7.29.0. It is reached only through the desktop app's development
dependency `electron`, whose `@electron/get` downloads the Electron binary at install time, so no
released package ships it. Version 7.29.0 carries two high advisories: denial of service through an
unrequested response (GHSA-rfgv-xxqx-mfg5) and a TLS certificate validation bypass
(GHSA-w293-vg96-wgc3). Only `undici` moves in the lockfile.
