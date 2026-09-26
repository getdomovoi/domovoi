---
"@getdomovoi/daemon": patch
---

Refuse a WSL service install whose Windows task would carry a percent sign or `$(`. Task
Scheduler expands `%NAME%` and substitutes `$(Arg0)` through `$(Arg32)` in the wsl.exe path and
arguments when the task runs, so the task could run something other than what install checked.
The distribution name, the Linux user, the guest runtime and entry, the wsl.exe path and the
configuration path are refused before any file is written or any task command runs.
