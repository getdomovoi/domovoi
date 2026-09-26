---
"@getdomovoi/desktop": patch
---

Update Electron from 44.2.0 to 44.4.5. This brings the upstream Chromium security fixes that
Electron shipped since 44.2.0: Chromium 152.0.7977.130 and backported fixes from ANGLE, Chromium,
Dawn, PDFium, Skia and V8. It also moves the embedded Node.js from 24.20.0 to 24.21.0, which
updates OpenSSL to 3.5.8 and the root certificates to NSS 3.126.
