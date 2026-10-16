---
"@getdomovoi/ui": minor
---

The move dialog can list every machine in the fleet as a target. Each row says whether that
machine could take the session now: the machine that holds it, a reachable machine with its
route, or the reason it cannot (unreachable, not answering, needs pairing or an upgrade). Picking
a reachable row moves the choice there. The pre-flight summary reads "2 pass" or
"1 pass · 1 blocking" instead of "1 warnings". The dialog scrolls inside a short window.
