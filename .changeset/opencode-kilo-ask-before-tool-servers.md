---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo sessions ask before every tool that is not one of the server's own. The embedded
configuration now starts its permissions with a `"*": "ask"` rule and restates each server's own
rules for its built-in tools after it, in the top-level block and in every agent block, so a call
to a tool server's tool, the person's own included, raises an approval card, and every built-in
tool keeps the action it had in each agent a session runs. A session is refused when a tool server
or a tool that is not the server's own could take a name the server's own tools ask under. Kilo's
explore subagent now sees tool server tools and asks before each call, where they were hidden
before. A steer the server accepts after its turn has ended is aborted and reported as failed, and
a tool call from a run outside any turn aborts that run.
