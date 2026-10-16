---
"@getdomovoi/daemon": patch
---

Remove the temporary transfer root a daemon created for itself. A daemon on in-memory state has no
directory beside its state file to keep transfer packages in, so it makes one under the operating
system temporary directory. Nothing removed it, so every such daemon left a
`domovoi-transfer-transactions-` tree behind for the life of the machine.

The daemon now records the root it created and removes it as the last step of shutdown, after the
store and the usage ledger are closed and nothing is still writing packages into it. Removal
retries a refusal from a transfer that just released a file, and a removal that still fails is
reported with the rest of the shutdown failures instead of being dropped.
