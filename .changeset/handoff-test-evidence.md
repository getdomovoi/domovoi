---
"@getdomovoi/daemon": patch
---

A cross-provider handoff now tells the next provider how many recognized test runs passed and failed in the session, from the same thread evidence `session.evidence` reports. Before, it always sent the session summary's counters, which are set to zero when a session is created and never updated, so the receiving agent was told no test had passed or failed.
