---
"@getdomovoi/daemon": patch
---

Say what `wsl.exe` could not do instead of calling it absence. `domovoid wsl
list` and `domovoid open` now report whether WSL is not installed, the call was
denied, it timed out, the service or distribution failed, or the answer could
not be read, each with its remedy, instead of reporting a missing distribution
or a missing daemon. An endpoint file that is not one a daemon published is
refused as unreadable and nothing in it is repeated.
