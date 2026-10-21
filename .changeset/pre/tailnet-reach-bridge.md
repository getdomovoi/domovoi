---
"@getdomovoi/desktop": minor
"@getdomovoi/ui": minor
---

The desktop bridge gains `tailnetReach(action)` for `status`, `on` and `off`.
The preload passes the main process's answer on only when it holds known keys,
booleans and bounded strings; `parseTailnetReachReport` and
`parseTailnetReachOutcome` in `@getdomovoi/ui` parse its exact shape. The client
gains `tailnetStatus()` for the daemon's `tailnet.status`.
