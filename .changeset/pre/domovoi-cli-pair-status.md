---
"@getdomovoi/cli": patch
---

Add `@getdomovoi/cli`, the `domovoi` command: the terminal client for a daemon. `domovoi pair`
takes the client credential `domovoid pair --client cli` printed, proves it with an
authenticated hello, and keeps it in the OS keychain, or in an explicit `--credential-file`
with mode 0600 and a stated warning where no keychain exists. `domovoi status` reports the
daemon, its sessions, and for each fleet machine the route the daemon would choose for this
client. Loopback and tailnet only; the relay route waits on the relay crypto design like every
other client.
