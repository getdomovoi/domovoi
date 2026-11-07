---
"@getdomovoi/mobile": patch
---

The Everything is idle card on the phone no longer always says two machines are answering. It
counts the machines that answer from the fleet the daemon reported, names the machine the phone
reads when it is the only one, and vouches for no work in flight only on that machine, because the
fleet list carries no other machine's sessions. The fleet is listed under the card, one row per
machine with its light and how it is reached or when it was last heard.
