# Daemon update dispatch

The daemon implements `update.status`, `update.check` and `update.activate` for
signed discovery and staging. All three RPCs require a direct loopback connection,
an authenticated client identity and the daemon owner's credential. Paired client
credentials, paired machine credentials, relay connections and watch admission
cannot call these methods. Forwarding headers do not establish loopback authority.
The separate local-owner discovery proof identifies the daemon to the client; it
does not grant client authority.

## Installation policy

The production factory gives the updater its home directory and held profile
lease. It reads `<home>/.domovoi/update-policy.json` as a bounded private file.
Missing policy disables checks. Invalid or inaccessible policy refuses with
`policy`; it never discovers a trust root from the network. Installer provisioning
must supply these fields, using `storedUpdatePolicySchema`:

- `format`: `1`.
- `channel`: `stable` or `beta`.
- `metadataBaseUrl`: HTTPS directory containing the four signed metadata files.
- `artifactBaseUrl`: HTTPS release base consumed by the existing bootstrap installer.
- `trustedRoot`: the independently provisioned root metadata envelope.
- `automaticChecks`: reserved installer authorization for a future scheduler.

URLs cannot contain credentials, query strings or fragments. RPC parameters cannot
set these URLs, replace the trusted root or enable automatic checks. This slice
adds neither an installer policy writer nor a periodic scheduler. The unused
background-check entry was removed; stored authorization has no caller until
the scheduler slice implements and tests that boundary.

## State and persistence

A check reads persisted trusted versions and digests, fetches bounded metadata,
runs `verifyUpdateChain`, refuses replay or same-version changed bytes, selects the
channel target, and stages it through `stageVerifiedUpdate`. Metadata persistence
runs only after successful staging, or after a verified no-update result. Pending
state is published only after that persistence succeeds. Neither failed staging
nor failed persistence authorizes activation of the checked target. A failed
refresh retains the previous verified pending target and reports its version
alongside the failure in `deferred` state. While checking, the schema omits pending
fields but the previous verified target remains held internally. Re-staging that
same runtime clears its pending authority
before touching its bytes; it must succeed and persist again to become pending.
A successful check replaces pending state, including clearing it on no update.

Concurrent checks for the same channel share one operation. A competing channel
receives `busy`. Status remains readable during a check. Shutdown waits for the
operation before the production factory releases its profile lease.

The implemented states are `idle`, `checking`, `pending`, `deferred` and `failed`,
validated against the protocol schema. Pending state is in memory: after restart,
the daemon must run a fresh verified check. Persisted trusted metadata still
prevents replay. Downloaded bodies and exception messages are not returned in
refusals.

## Activation boundary

Activation requires a verified pending target. An explicit different version
refuses with `target-mismatch`. A matching target remains pending in `deferred`
state with reason `policy`. Idle-boundary detection and platform activation are
out of scope until the activation matrix lands. This code does not enter
`activating` or `quarantined`, restart a service, or switch an active receipt.
It does not complete S1.4.
