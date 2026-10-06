---
"@getdomovoi/daemon": patch
---

Supervise the Windows logon daemon in a job object with bounded crash restart and recorded exhaustion. Require job-empty evidence before restarting or removing a supervised tree, and refuse ambiguous same-boot recovery until Windows restarts.

Allow removal, reinstall, and update of a supervised registration that never launched after Task Scheduler confirms it is disabled with no instances and the startup lease protects the empty launch history.
