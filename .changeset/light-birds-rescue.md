---
"@getdomovoi/daemon": patch
---

Opening a project now ends every turn saved with it, for Codex and Claude Code sessions as well as
Cursor and Grok, the same way a daemon restart does. The session goes idle and its thread says
"Daemon restart interrupted the active turn." Only one daemon owns a profile, and closing a project
asks its providers to stop their turns. Pause and emergency stop then find an idle session and make
no provider call. A Claude Code stop can return before its process has exited; that is tracked
separately.
