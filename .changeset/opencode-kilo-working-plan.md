---
"@getdomovoi/daemon": minor
---

OpenCode and Kilo sessions now keep a working plan. Each todo list their todowrite tool publishes in a Build or Ask turn replaces the plan in its order, as Codex's plan does. A cancelled todo leaves the plan, since the plan has no cancelled state. In Plan mode the todos track the agent's research and the final reply stays the proposal, as with Claude. A subagent's todos, a list published outside a turn, and a list published before the server shows the turn's own prompt (such as an interrupted run's late list) do not change the thread's plan.
