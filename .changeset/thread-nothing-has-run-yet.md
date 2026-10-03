---
"@getdomovoi/ui": patch
---

A session with a worktree and an empty thread now shows the design's fresh state on desktop and web:
a "Worktree ready" strip naming the worktree and its base commit, "Nothing has run yet" with its
body, a "What it will do first" card, and the placeholder "Say what you want done in <project>".
The card's rows come from the session's permission mode and from the daemon's checkpoint policy, a
checkpoint before each command you allow, so they differ for Plan, Ask, Build and Build with Auto.
The design's starter suggestions are not drawn.
