---
"@getdomovoi/daemon": patch
---

Provider exit reasons read the child's stderr once its streams have closed. The Codex app-server
transport and the ACP agents built the "exited with code 1: <stderr>" reason in the process `exit`
handler, and Node documents that stdio may still be open when `exit` fires, so the last line a
crashing CLI printed ("401", "Not logged in") could miss the reason and the failure be classified
as unknown. The reason is now built on `close`. A grandchild that inherited the pipes can hold
`close` off indefinitely, so the end is reported 500 ms after `exit` if `close` has not come by then.
