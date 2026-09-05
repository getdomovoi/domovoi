---
"@getdomovoi/daemon": patch
"@getdomovoi/protocol": patch
---

Generate release SBOMs from the daemon's packed runtime lock, including non-host optional
packages and the embedded protocol. Component SHA-512 hashes and the separate protocol
artifact are bound to the locked archive bytes. Validate CycloneDX 1.6 offline before
publishing checksums. Missing local license observations remain empty rather than hiding
components; external toolchains and unfrozen manual installs remain outside this inventory.
