---
"@getdomovoi/credential-store": minor
"@getdomovoi/daemon": patch
---

Allow durable file publication to accept an optional deadline. Forward the existing
service install or update deadline to runtime publication so Windows sharing retries
stop before starting a rename after that deadline.

Retry Windows sharing refusals when replacing the skill trust file, which the daemon
may hold open while listing skills.
