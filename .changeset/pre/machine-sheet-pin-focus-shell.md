---
"@getdomovoi/ui": patch
---

Place focus deliberately when the dock is pinned or unpinned. Pinning unmounts the floating sheet rather than updating it, so its focus-return cleanup sent the keyboard back to whatever opened the sheet.
