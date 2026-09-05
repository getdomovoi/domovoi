---
"@getdomovoi/daemon": patch
---

Grade a fleet peer that refuses this daemon's protocol by which side is behind.
The dialer reads the peer's version out of its refusal, and the heartbeat
records `upgrade-required` when the peer is the older side and
`version-mismatch` when it is the newer one, where it recorded
`version-mismatch` for both. A refusal that names no version is graded by the
version the peer last advertised.
