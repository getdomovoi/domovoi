---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo now list the models of a provider signed in after Domovoi started their server.
The server reads credentials and models once for each directory it is asked about and keeps them
while it runs, and Domovoi asked about the same directory every time, so a provider added later,
such as OpenRouter through `opencode auth login`, stayed missing from the launcher and the composer
until the daemon restarted. Each model read now asks about a new empty directory, then has the
server forget it and removes it. The server still keeps what it read for a directory it already
knows: a session that was already open, or an adopted session in a directory the server read
before, does not gain the new provider until the daemon restarts. A new session opens in a new
worktree, which the server reads afresh.
