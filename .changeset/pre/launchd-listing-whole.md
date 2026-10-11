---
"@getdomovoi/daemon": patch
---

The launchd check reads `launchctl print gui/<uid>` whole: the listing must open with that domain, close every block it opens and hold one services block, and a row that names Domovoi anywhere but as its one, last field is refused as unreadable, so a truncated listing or a label with a space cannot pass as having no Domovoi job.
