---
"@getdomovoi/daemon": patch
---

Claude and Codex sessions produce a working plan again. Claude Code 2.1.292 offers no plan tool to
current models unless `CLAUDE_CODE_ENABLE_TODO_TOOLS` is set, and its plan tools are now TaskCreate,
TaskUpdate and TaskList rather than TodoWrite. The daemon starts Claude with that variable set and
builds the working plan from those calls, keeping TodoWrite for older Claude Code. A resumed Claude
session reads its task list from Claude's own task storage, read only, so updates after a daemon
restart keep the whole plan. In Plan mode the task checklist is not reported as the plan, so the
proposal in Claude's reply still becomes the plan. Codex 0.160.1 registers `update_plan` only when
`tools.update_plan.enabled` is true, so every thread the daemon starts or resumes now sets it,
overriding a person's own `false` for Domovoi threads.
