---
"@getdomovoi/desktop": patch
---

Ship license notices with every desktop build. `THIRD_PARTY_NOTICES.txt` in the resources
directory names each bundled package with its declared license and the license and notice files it
publishes, including the OFL-1.1 text of the two renderer fonts. macOS builds now also carry
Electron's `LICENSE.electron.txt` and `LICENSES.chromium.html`, which Linux and Windows builds
already kept beside the executable. Packaging stops when Electron's notice files are missing, and
the license audit now covers the desktop app's graph and Electron as well as the npm packages.
