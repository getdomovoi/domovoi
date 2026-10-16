---
---

Internal daemon refactor: helpers that act for a session now find that session's own project
instead of the open one, audit records about a session name its project, and skill catalogs are
kept per project path. Only one project can be open, so nothing a package user sees changes.
