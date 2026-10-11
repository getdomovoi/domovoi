---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": patch
---

Make the fleet machine id contract authoritative for canonical workspace identity. `machineSchema.id` and `projectSchema.machineId` accepted any nonempty string while the fleet, credential, and pairing contracts require `machine-[0-9a-f]{32}`, so a workspace could be schema-valid while its machine could not be recorded in the fleet or used for pairing. Both fields now reuse `machineIdSchema`, and the existing snapshot refinement continues to require the project to name the workspace machine.

A workspace saved with a non-canonical machine id is migrated on load rather than quarantined: the daemon replaces the legacy id with a deterministic canonical id derived from it, aligns the stored project reference, and records a system thread receipt naming both values. Sessions, approvals, artifacts, and annotations are preserved. A daemon started with a machine identity file still refuses state that names a different machine, which is unchanged behavior.
