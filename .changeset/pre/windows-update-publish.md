---
"@getdomovoi/daemon": patch
---

Updating a Windows logon task publishes the staged runtime under the profile lease, after the task is stopped and before service.json names the new runtime and the task is registered to run it, as on the other platforms.
