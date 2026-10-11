---
"@getdomovoi/cli": patch
---

Add `domovoi daemon install|status|remove`. It runs `runDaemonCommand` from
`@getdomovoi/daemon/daemon-command`, now a dependency of this package, so the login service
registers the daemon's own `dist/index.js`, never this CLI's entry. The three commands keep the
exit codes of `domovoid service`: status exits 0 when the service is installed, even if it is
stopped, and 1 when it is not or its supervision failed; install and remove exit 0 on success and
1 on failure. A verb the command does not have is a usage error, exit 2. Where the daemon package
is not installed beside the CLI, as in the desktop app's runtime, it loads the one daemon at
`../../daemon/dist/daemon-command.js` from its own `dist`, and refuses when that is absent too.
