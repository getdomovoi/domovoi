---
"@getdomovoi/daemon": patch
---

Terminal redaction no longer leaks a value split across reads or idle beats. Each terminal read
is redacted in the context of its whole current line, and what is shown is how the redacted line
grew, so a value is caught however its name, separator, whitespace, quotes and value were split.
The daemon used to hold back a tail that might become a secret and release it on a short idle beat
so a prompt showed; a value typed after the released part went out in clear, live and in the
replay a rejoining client is handed. Nothing is held now except a bare token (sk-, ghp_, a JWT)
still being printed, so prompts show at once. A value longer than a line's 8,192-character
context is dropped up to where it ends.
