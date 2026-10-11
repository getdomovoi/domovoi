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
before. A steer the server accepts after its turn has ended is aborted and reported as failed. A
tool call started or an approval asked for by a run outside any turn, a subagent's included,
aborts that run, and the approval is refused. A turn now ends only on an idle after its own reply
has completed or failed, so an aborted run's idles no longer end a later turn; a stopped or
interrupted turn ends when the abort is answered. Aborts to a session go out one at a time, an
abort not answered within ten seconds counts as failed, and a new prompt waits for a pending abort.
A finished tool's report no longer aborts a turn. A turn whose end the events do not show, such as
one whose replies follow automatic compaction or whose setup failed, is settled from the server's
session status and messages two seconds after an idle, error or failed abort; a busy session
settles nothing, and reads that keep failing end the turn after thirty seconds.
