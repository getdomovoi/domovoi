---
"@getdomovoi/protocol": minor
---

Adds the `tool.inventory` method: what each agent's own configuration files on one machine
declare, as tool servers, hooks, permission rules, environment keys, helpers, plugins and skills,
each with the file that declared it and whether it runs when a session starts. Every file is
reported as read, empty, absent or unreadable with a reason, and entries come only from files that
were read. Environment entries carry key names only, as identifiers; no field holds a value. The
daemon redacts every text field before sending it, and the schema refuses any text that still
carries an assignment, a sensitive flag with its value, or a known token shape. Text is one line
with no format characters or separators. A remote tool server is named by a valid host and a port
from 1 to 65535, never a URL path, query or user info. A response stays within 256 KiB, and each
agent counts the entries it left out to fit. Entries the repository brings can be marked
held back, and the inventory carries a digest of the repository's configuration files so a later
trust decision can pin to what the client was shown. An agent Domovoi starts with no tool servers
says so rather than listing none found. The method is observe-tier and read-only, and phone and
tablet credentials do not get it. The daemon does not answer it yet.

Approval requests now refuse fields they do not define instead of dropping them, and gain an
optional `toolServer` fact naming the server, its transport, and the
file that declared it. Such a request never carries a resolved execution record, so a tool server
call is answered with Allow once or Deny and never becomes a standing rule.
