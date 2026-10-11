---
"@getdomovoi/daemon": patch
---

Service follow-up lines name the command that was run. Through `runDaemonCommand`, which the
`domovoi` CLI calls, they name `domovoi daemon install`, `status` and `remove`, and profile
recovery reads `domovoid profile recover --confirm-no-supervisor (domovoid is Node running
<daemon entry>)`. Through `domovoid service` they keep the `domovoid` spelling. This covers the
Linux lingering lines, the profile recovery advice after removal, the interrupted WSL update
advice and the Windows removal failure. The supervised worker's exhaustion lines name both
status commands.

A macOS removal whose stopped daemon does not let the profile go in time now says so in its own
words, keeps the launch agent file and saved configuration, and asks for the removal again once
that daemon has exited, instead of the update's sentence.
