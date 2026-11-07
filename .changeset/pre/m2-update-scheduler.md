---
"@getdomovoi/daemon": patch
---

Schedule non-overlapping signed update checks after daemon startup when the private stored policy explicitly enables automatic checks. Reread authorization and channel at each hourly boundary and drain admitted work during shutdown.
