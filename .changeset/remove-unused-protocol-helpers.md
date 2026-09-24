---
"@getdomovoi/protocol": patch
---

Remove exports nothing outside the protocol's own tests used: `planTransfer`, `TransferPlan`, `transferStepSchema` and `TransferStep` (sessions move through the `transfer.*` RPCs), `selectTransport` and `TransportSelection` (dialers use `usableTransports`), and the aliases `maximumClientSnapshotThreadItems`, `maximumRenderedThreadItems` and `machineCredentialSchema`. No wire member changes. The transport tests now assert the same behaviour through `usableTransports`.
