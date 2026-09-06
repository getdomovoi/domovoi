---
"@getdomovoi/daemon": patch
---

Release one-shot CLI connections after a complete reply as well as after a refusal.
A peer that withholds its close acknowledgement can no longer keep an answered
`domovoid pair` or `domovoid open` process waiting outside the command deadline.
No configuration changes or re-pairing are required.
