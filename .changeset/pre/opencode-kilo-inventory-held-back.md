---
"@getdomovoi/daemon": patch
---

The tool inventory reports a repository's OpenCode and Kilo configuration as held back. Both servers
start with their project configuration switched off, and Kilo's legacy files refuse the session, so
every entry from their config files and folders is now marked held back. Skills under
`.claude/skills` and `.agents/skills` stay marked as loading, because both servers still load them.
