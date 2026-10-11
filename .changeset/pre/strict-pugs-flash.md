---
"@getdomovoi/daemon": patch
---

Install the verified daemon archive through its reviewed production dependency lock. Package the
integrity-bearing lock under a non-special name, bind the same-release protocol archive, and use
private staging with bundled npm 10.0.0 or newer. Materialise the lock as package-lock.json, run
npm ci without dependency scripts, verify the physical graph and fetched-integrity records, run
only the reviewed node-pty build, and publish a runnable receipt after verification.

The bootstrap keeps one five-minute total deadline including installation, native build,
verification, and cleanup. Existing or concurrent matching installs are verified and reused,
never overwritten. Failure can retain a verified archive or private staging but is not reported
as a completed installation. No provider SDK is bundled, no service starts, and PATH is unchanged.

Manual npm, pnpm, or Bun adds of the daemon are not frozen. Native compilation, Node, the OS, and
the external toolchain remain reproducibility limits. The protocol library still supports all
three package managers independently.
