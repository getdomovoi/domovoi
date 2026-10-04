---
"@getdomovoi/ui": patch
---

Permission mode and session lookup tables are typed over their unions, so a new member fails to compile instead of falling through.
