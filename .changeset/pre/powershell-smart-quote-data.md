---
"@getdomovoi/daemon": patch
---

Windows task scripts pass the task name, and WSL task scripts pass the task name, registration source, `wsl.exe` path and action arguments (the distribution, Linux user and guest paths), as UTF-8 base64 data. PowerShell ends a single-quoted string at the smart quotes ’ ‘ ‚ ‛ as well as at the ASCII apostrophe, so doubling the apostrophe alone let such a value end its string.
