---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

`session.search { query, limit? }` searches a daemon's sessions by title and by summary, the
newest assistant message the daemon holds for the session, case-insensitively, and answers
`{ query, matches: [{ session, matchedIn: "title" | "summary" }], truncated }` without a whole
snapshot. It is read-only and unaudited, like `session.history`. A desktop or web client fans it
out per admitted machine for the palette's "Sessions on other machines"; each machine answers
for itself, so a machine that did not answer stays "not searched" rather than "no match".
