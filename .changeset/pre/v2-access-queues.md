---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

Add watching-only client authorization, durable policy refusals, and daemon-owned next-turn message queues.

The wire protocol moves to 0.8.0. Update clients and daemons together: a peer on another minor version is refused at `system.hello` with `-32012`.
