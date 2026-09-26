---
"@getdomovoi/daemon": patch
---

The Codex notice's repository-history scan now refuses every Git transport while it runs, so a
partial-clone setting written after Domovoi's check cannot make it fetch, and it does not run at all
with a Git older than 2.45, which cannot refuse lazy fetches; the notice then says "Domovoi could
not finish checking the repository history."
