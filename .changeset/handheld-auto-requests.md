---
"@getdomovoi/ui": patch
"@getdomovoi/web": patch
---

A phone or tablet browser tab no longer sends, on its own, a request the daemon refuses for that
credential. The daemon answers such a request with an authentication error and the client then
closes its connection, so every phone or tablet tab with a project open dropped. The tab now lists
the project's skills (skill.list) without reading the machine's skill inventory (skill.inventory),
and Settings asks for neither update status (update.status) nor key status
(provider.secret.list). About this build says the daemon answers update status only over
loopback to its owner's credential, and Direct API keys says key status is off in a phone or
tablet tab and names the desktop app. The move dialog no longer asks the daemon for a preview
(session.transferPreview) as it opens in a phone or tablet tab; it says moving a session is off
there and offers no Move session. Skills in a phone or tablet tab lists the catalog but disables
Install, Trust, Revoke and View SKILL.md, and says why, as it does for the machine comparison. A
queued message with chosen skills is released once the skill list for the current project and
branch has answered, so a branch change no longer releases it against the old list. Desktop and
full-access web tabs are otherwise unchanged.
