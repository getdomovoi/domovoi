---
---

Test-only: the desktop package contents test sends electron-builder's log to stderr and fails if an electron-builder call writes to stdout, where the test runner reads its report. No package changes.
