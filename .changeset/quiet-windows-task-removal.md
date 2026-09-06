---
"@getdomovoi/daemon": patch
---

Stop and verify the Windows logon task before removing its registration and saved configuration.
Previously removal could report success while the daemon kept running. Windows removal now uses
the built-in PowerShell Task Scheduler API, disables new starts, and shares one 30-second deadline
across all phases. An unavailable manager, unknown state, or timeout refuses with an actionable
task-specific error instead of falling back to deletion. Credentials, identity, session state, and
worktrees are not removed.
