---
"@getdomovoi/daemon": patch
---

Supervise the Windows logon daemon in a job object with bounded crash restart and recorded exhaustion. Require job-empty evidence before restarting or removing a supervised tree, and refuse ambiguous same-boot recovery until Windows restarts.

Allow removal, reinstall, and update of a supervised registration that never launched after Task Scheduler confirms it is disabled with no instances and the startup lease protects the empty launch history.

Recover after helper death using recorded kill-on-close confirmation, absence of the exact Global job name, and death of the recorded daemon identity. This establishes termination started, completion not observed; the profile lease guards a second owner.

Keep Windows retirement active and hold the startup lease until Task Scheduler confirms the old task is disabled with no instances before allowing an update or reinstall to restart it.

Preserve Task Scheduler removal for recognized legacy Windows tasks and migrate them to job supervision on install or update. Scheduler retirement does not prove every legacy descendant dead; profile changes still require the free profile lease.

Retire and stop an existing supervised Windows registration before reinstall writes new configuration, including when its last supervisor stopped or exhausted its retries.

Bound Windows process and job observations by the remaining service-operation deadline, reject expired observations, and retain the 20-second per-query ceiling.

Report Windows status from boot and terminal tree evidence without opening stale recorded PIDs that may have been reused by protected processes.

Restore the prior supervised Windows task action and enabled state when reinstall cannot publish its runtime, write its configuration, or register the replacement. Recreate a deleted registration without issuing a demand start; retain the disabled task if configuration restoration fails.
