---
"@getdomovoi/daemon": patch
---

Redact only the thread items a stream changed when saving the workspace. Every save used to run
every redaction rule over the project's whole thread, which was about 90% of a save's time and grew
with history: 17 ms at 1,000 thread items and 174 ms at 10,000. The persistence worker now keeps
the redacted copy of each item and reuses it while the item is unchanged, compared by value, so a
save redacts the approvals, the rules and the items that changed. The whole snapshot is still
validated and written on every save. A worker save now takes 9 ms at 1,000 items and 89 ms at
10,000, down from 25 ms and 258 ms.
