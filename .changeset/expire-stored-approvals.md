---
"@getdomovoi/daemon": patch
---

Expire every stored pending approval card when the daemon starts and when a project's saved state is opened again. A stored card's provider request id came from a provider process or thread that is gone, and a new provider process can issue the same id to a live request in another session, so allowing or archiving the stale card could decide that request. Startup archive recovery no longer sends a decision to the provider for stored cards. The agent asks again when the session continues.
