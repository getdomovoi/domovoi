---
"@getdomovoi/ui": patch
---

Update the service reads the service back and asks the desktop to resolve its daemon again when its answer cannot be read or the updated service could not be reached, as install and remove do, so a finished update is not left with stale service state.
