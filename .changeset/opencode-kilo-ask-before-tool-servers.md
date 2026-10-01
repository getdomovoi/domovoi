---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo sessions ask before every tool that is not one of the server's own. The embedded
configuration now starts its permissions with a `"*": "ask"` rule and restates each server's own
rules for its built-in tools after it, so a call to a tool server's tool, the person's own
included, or to a plugin's tool raises an approval card, and every built-in tool keeps the action
it had in each agent a session runs. Kilo's explore subagent now sees tool server tools and asks
before each call, where they were hidden before.
