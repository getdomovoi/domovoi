---
"@getdomovoi/ui": patch
---

The machine sheet's scrim draws again (bg-overlay was never registered). A test now compiles the real sheet, scans every source the sheet names with the build's own scanner, and fails on any colour-carrying utility that resolves to no CSS.
