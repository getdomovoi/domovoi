---
"@getdomovoi/daemon": patch
---

Give audit queries and exports their own finite 30-second read deadline, independent of agent operations. A short agent timeout no longer cancels valid audit reads. Preserve audit cancellation and rejection of results that arrive after the audit deadline.
