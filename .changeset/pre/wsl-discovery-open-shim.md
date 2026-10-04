---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": patch
---

Discover WSL distributions from Windows and open work inside them through the
daemon that runs there. `domovoid wsl list` asks `wsl.exe` for every
distribution, its WSL version and state, and whether a Domovoi daemon has
published an endpoint inside it, reporting the loopback endpoint WSL forwards
and never the credential. `domovoid open` on a `\\wsl$` or `\\wsl.localhost`
path asks that distribution's own `wslpath` where the path lives and sends
`project.open` to the daemon inside it; a stopped distribution, a WSL 1
distribution, a distribution with no daemon, and a Windows drive the
distribution mounts are each refused with the remedy, without assuming where
drives are mounted. A daemon refuses `project.open` on a WSL share path, so
no repository work runs through `\\wsl$`. A daemon inside a distribution
reports the distribution and WSL version in its fleet facts, and the Fleet
surface names it as the distribution with a WSL mark.
