---
"@getdomovoi/daemon": patch
---

Git for Windows' default `diff.astextplain.textconv = astextplain` no longer makes a Claude Code Git
read ask or stop the Codex notice's history scan. Any other value for that key, and any other diff
textconv, still does.
