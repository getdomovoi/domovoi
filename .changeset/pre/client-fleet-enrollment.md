---
"@getdomovoi/ui": minor
---

Pair a machine through one fleet.enroll call to the daemon, so no machine
credential reaches the client. The fleet is read as lifecycle entries: pending
and unenrolled rows render in place, the pairing-required and
credential-store-unavailable health states get their own copy, Forget is
offered with the daemon's revocation verdict repeated verbatim, and Use and
Terminal on a remote machine are disabled because no client credential exists
for it yet. The workspace hook holds the fleet, applies fleet.changed, and
lists again on every reconnect. A fleet list the daemon withholds because its keychain
exceeds the wire limit is shown as withheld, with the entry counts and the
daemon-side keychain CLI as the remedy, never as an empty fleet.
