---
"@getdomovoi/daemon": minor
---

Replace the public raw daemon constructor with `createProductionDaemon`. The
factory always installs a durable root credential and machine identity,
provider discovery, the peer-credential store, persistent state, and configured
transport protection, so shipped entry points cannot omit production
dependencies that tests inject.

This is a breaking embedding API change. Consumers must await the factory and
use its returned handle.
