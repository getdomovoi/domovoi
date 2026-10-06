---
"@getdomovoi/daemon": patch
---

Supervise the Windows logon daemon in a job object with bounded crash restart and recorded exhaustion. Require job-empty evidence before restarting or removing a supervised tree, and refuse ambiguous same-boot recovery until Windows restarts.
