---
"@getdomovoi/daemon": patch
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

A waiting gate always notifies. Settings draws "A gate is waiting on you" first and locked on, in
the desktop and in a browser, and a stored preference from an older build that switched approval
notifications off now reads as on.

Theme, window decoration and notifications stay on the client, so a window that is only watching
can change them. Nothing about them reaches the daemon.

Settings' Elsewhere links Permissions and rules and Checkpoints to the sheet's Rules and
Checkpoints tabs.

On Machines, a paired client's row says Unpair; a machine binding keeps Revoke. The rows sit in one
card under its heading, each with its consequence as a standing line, and a rotated credential is
shown in an info-tinted panel that says it is shown once and that Domovoi keeps a digest, not the
secret.

Removing the login service on Linux now says what became of lingering, in the daemon's own words:
turned off, left on because it was on before Domovoi was installed, or could not be turned off.
