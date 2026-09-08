---
"@getdomovoi/ui": minor
"@getdomovoi/web": minor
---

Give the browser client the host capabilities the desktop already has, and stop the browser holding
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
