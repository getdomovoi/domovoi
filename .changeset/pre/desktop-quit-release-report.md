---
"@getdomovoi/desktop": patch
---

Desktop quit no longer reports a bounded daemon release as a clean shutdown.
When the ten second release bound wins the race, the lifecycle now reports a
`DesktopDaemonReleaseTimeoutError` naming the pending release and the bound it
outlived, so the failure reaches the main-process error sink. Quitting still
proceeds without waiting for a release that will not settle, and a release that
settles inside the bound reports nothing.
