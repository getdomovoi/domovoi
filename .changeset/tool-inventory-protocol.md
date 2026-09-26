---
"@getdomovoi/protocol": minor
---

Adds the `tool.inventory` method: what each agent's own configuration files on one machine
declare, as tool servers, hooks, permission rules, environment keys, helpers, plugins and skills,
each with the file that declared it and whether it runs when a session starts. Every file is
reported as read, empty, absent or unreadable with a reason, and entries come only from files that
were read. Environment entries carry key names only; no field holds a value. A remote tool server
is named by host and port, never a URL path or query. Entries the repository brings can be marked
held back, and the inventory carries a digest of the repository's configuration files so a later
trust decision can pin to what the client was shown. An agent Domovoi starts with no tool servers
says so rather than listing none found. The method is observe-tier and read-only, and phone and
tablet credentials do not get it. The daemon does not answer it yet.

Approval requests gain an optional `toolServer` fact naming the server, its transport, and the
file that declared it. Such a request never carries a resolved execution record, so a tool server
call is answered with Allow once or Deny and never becomes a standing rule.
