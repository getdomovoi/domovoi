---
"@getdomovoi/ui": patch
---

Two slash command notes now say what the daemon does. `/run` reads "Asks the agent to run it in the
worktree. Gates and rules apply as to any command the agent runs." It no longer claims the gate says
the request came from you, which nothing reports. `/skill` reads "Loads a skill for this turn only.
With Auto on, the daemon refuses a skill that is not trusted."
