---
"@getdomovoi/daemon": patch
---

Add an HTTP handler for a loaded Domovoi web bundle, with validated listener authorities, explicit security headers, cache revalidation and fixed unavailable-state pages. The handler serves only loaded files and does not read from disk per request. Listener integration follows separately, so the daemon serves no new routes yet.
