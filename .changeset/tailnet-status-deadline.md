---
"@getdomovoi/desktop": patch
---

The desktop answers the tailnet switch's status within 15 seconds: the
tailscale status timeout of 10 seconds plus 5. When reading the saved record,
finding the tailscale command or anything else in the read has not finished by
then, the answer says there is no known tailnet and that the read took longer
than 15 seconds. Automatic reads, "Check again" and the read after a change are
all bounded this way. A read still held past its deadline is not started again:
later reads wait on it under their own deadline, until it settles or a change
starts. A read that answered at its deadline keeps that answer, and a tailscale
process the held read starts still ends at its own timeout.
