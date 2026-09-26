---
"@getdomovoi/daemon": patch
---

Recover a profile after verified service removal using an owner-only receipt bound to the exact
stopped instance and installation registration. New service installations carry that registration;
older saved configurations remain readable but need reinstalling to gain automatic removal proof.

For legacy or custom supervisors, `domovoid profile recover --confirm-no-supervisor` records the
operator's explicit assertion that no supervisor will restart the daemon. It refuses a live owner,
does not start a daemon, and does not treat missing configuration or elapsed time as shutdown proof.
