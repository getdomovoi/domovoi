---
"@getdomovoi/daemon": patch
---

Windows fleet dialing can reach an enrolled WSL 2 daemon through a freshly authenticated local route. Pair the guest first and run domovoid inside the distribution on a distinct loopback port. No new pairing or wire migration is required.

The source checks the distribution before each attempt, uses the existing paired-machine credential, and produces a WSL candidate only after the expected daemon authenticates. A stopped distribution, stale endpoint or rejected credential does not produce a route. Discovery, connect and hello share the route's slice of the overall dial deadline. Root credentials from endpoint files are never used for fleet admission.
