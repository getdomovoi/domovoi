---
"@getdomovoi/daemon": patch
---

Skip unchanged project rows on save and preserve operational errors when restoring several active projects.

Configure the active-project admission cap with DOMOVOI_PROJECT_CAP, including saved service settings. Default to three and accept values from one through sixteen.
