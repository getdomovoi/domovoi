---
"@getdomovoi/daemon": patch
---

Ask the distribution where a repository is before running `git` there. The
runner that starts `git` inside a WSL distribution asks the distribution's
own `wslpath` which Windows path the repository reads back as, so a Windows
drive is refused wherever the distribution mounts it, not only under `/mnt`.
