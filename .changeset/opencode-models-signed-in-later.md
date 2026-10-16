---
"@getdomovoi/daemon": patch
---

OpenCode and Kilo now list the models of a provider signed in after Domovoi started their server.
The server reads credentials and models once for each directory it is asked about and keeps them
while it runs, and Domovoi asked about the same directory every time, so a provider added later,
such as OpenRouter through `opencode auth login`, stayed missing from the launcher and the composer
until the daemon restarted. Each model read now asks about a new empty directory, then has the
server forget it and removes it. A session that was already open keeps the providers its server
read for it: a model from a provider signed in later works in a new session.
