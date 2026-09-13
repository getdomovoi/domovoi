# @getdomovoi/web

## 0.1.0

### Minor Changes

- 22b46b6: Give the browser client the host capabilities the desktop already has, and stop the browser holding
  the daemon's root bearer.
  
  `WorkspaceShell` takes a `platform` port beside the desktop `windowBridge`. The browser build
  implements it against the browser's own APIs. Workspace notifications now reach a browser client, so
  the Notifications pane stops being three switches with nothing behind them. The pane names this
  client's delivery permission and install state, offers the permission request where the browser has
  not been asked, and disables the per-kind switches with the reason in view where the browser will
  not raise them at all. Copy worktree path is available to a browser and reports a clipboard refusal
  instead of doing nothing. Opening a project explains, in the launcher, why a browser has no folder
  picker: a File System Access handle names a folder on the device holding the browser, not one on the
  execution machine. Every refusal is typed and takes its copy from one table, so a capability the
  browser cannot honour always says what stopped it.
  
  The web client no longer stores the credential pasted at the connect prompt. That credential is the
  daemon's root bearer: it authenticates every client and cannot be withdrawn on its own. It is now
  spent once on `device.pair`, and only the client-bound device credential that comes back is kept for
  the tab. A paired client can revoke that device without disturbing any other client, and the daemon
  already closes a revoked device's socket. A bearer parked in session storage by an earlier build is
  dropped at startup. The root bearer still passes through the browser once, and a device credential
  has no expiry, so this is not yet a short-lived credential.

### Patch Changes

- Updated dependencies [077c912]
- Updated dependencies [1204d6c]
- Updated dependencies [22b46b6]
- Updated dependencies [2adb117]
- Updated dependencies [1204d6c]
- Updated dependencies [d927d11]
- Updated dependencies [54424c9]
- Updated dependencies [35d34d2]
- Updated dependencies [54424c9]
- Updated dependencies [d4228ee]
- Updated dependencies [0fed2e6]
- Updated dependencies [3d67826]
- Updated dependencies [91b1e15]
- Updated dependencies [251df6d]
- Updated dependencies [18f6543]
- Updated dependencies [b5b1aa9]
- Updated dependencies [ca22e9e]
- Updated dependencies [9e1e9c5]
- Updated dependencies [3a2bf89]
- Updated dependencies [c32065a]
- Updated dependencies [54424c9]
- Updated dependencies [4359bcf]
- Updated dependencies [54424c9]
- Updated dependencies [1204d6c]
- Updated dependencies [b5b1aa9]
- Updated dependencies [bedf4af]
- Updated dependencies [d22da12]
- Updated dependencies [54424c9]
- Updated dependencies [6f3379c]
- Updated dependencies [e736472]
- Updated dependencies [66ade99]
- Updated dependencies [30c547b]
- Updated dependencies [cdf5f87]
- Updated dependencies [1c67fba]
- Updated dependencies [e094929]
- Updated dependencies [20e7e91]
- Updated dependencies [9048458]
- Updated dependencies [5a33539]
- Updated dependencies [fb78eda]
- Updated dependencies [9387a5d]
- Updated dependencies [c3e566a]
- Updated dependencies [584e7d9]
- Updated dependencies [54424c9]
- Updated dependencies [5aafe95]
- Updated dependencies [67a2c58]
- Updated dependencies [31b48d4]
- Updated dependencies [03d4e4d]
- Updated dependencies [36520ce]
- Updated dependencies [f9f2352]
- Updated dependencies [ee3fe90]
- Updated dependencies [ea2b5ab]
- Updated dependencies [284ad5e]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [b5b1aa9]
- Updated dependencies [7cf6870]
- Updated dependencies [ef0d241]
- Updated dependencies [b2e5888]
- Updated dependencies [63457d9]
- Updated dependencies [e937e67]
- Updated dependencies [4a53519]
- Updated dependencies [fb78eda]
- Updated dependencies [45f488e]
- Updated dependencies [d0a58b7]
- Updated dependencies [6832713]
- Updated dependencies [6832713]
  - @getdomovoi/ui@0.1.0
  - @getdomovoi/protocol@0.1.0
