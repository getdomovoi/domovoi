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
- `metadataBaseUrl`: HTTPS TUF repository containing sequential numbered roots,
  timestamp metadata, and snapshot/targets metadata with consistent-snapshot names.
- `artifactBaseUrl`: HTTPS release base consumed by the existing bootstrap installer.
- `trustedRoot`: the independently provisioned root metadata envelope.
- `automaticChecks`: explicit boolean authorization for scheduled checks.

URLs cannot contain credentials, query strings or fragments. RPC parameters cannot
set these URLs, replace the trusted root or enable automatic checks. There is no
installer policy writer in this slice.

## Automatic checks

The daemon starts its scheduler only after successful startup, with the explicitly
configured updater and held profile lease. The first boundary is one hour later.
Each completed cycle schedules the next boundary one hour later, including cycles
that refuse local policy or receive an update failure. This is a local cadence,
not a hosted service commitment. Slow checks and process suspension do not create
catch-up bursts. Timers do not keep an otherwise stopped process alive.

At each boundary the scheduler synchronously rereads the bounded private policy
and immediately calls the existing updater with its stored channel, only when
`automaticChecks` is `true`. Missing, inaccessible, non-private or invalid policy
silently skips that admission without changing update status. A later valid policy
can enable a later boundary. Stable and beta remain the only accepted channels;
this adds no internal feed, trust root, signing or rollout authority. The policy's
URLs and trust root retain the existing validation and TUF verification gates.

The scheduler waits for its admitted check before creating another timer. Manual
and scheduled checks use the same updater, preserving same-channel coalescing and
competing-channel `busy` refusal. Channel changes take effect at the next admitted
boundary even if a manual check changed the updater's last status channel.

Authorization is an admission snapshot: an already admitted check may finish after
the policy is disabled, removed or changed. Shutdown fences new admissions and
clears the timer before waiting for admitted work. It does not cancel the ongoing
download or promise no network activity after shutdown begins. Scheduling never
calls activation, switches a runtime, or opens signing, provenance or native gates.

## State and persistence

A check passes the persisted trusted metadata bytes to the TUF client's `Updater`
through `fetchUpdateMetadata`. The client verifies sequential root rotation and
the bounded timestamp, snapshot, and targets chain. Accepted metadata bytes,
versions, and digests are persisted through an atomic, flushed write under the
profile lease before the next fetch and after refresh succeeds or fails. Verified
trust therefore survives a later metadata or staging failure.

An accepted root that changes timestamp or snapshot authority clears the retired
online metadata and its version/digest floors for fast-forward recovery. Dispatch
compares against the refreshed durable trust epoch, so the first successful
recovery check can stage a target even when its metadata versions are lower.
Unchanged authority retains rollback and same-version changed-byte refusals.
The root-rotation limit's retry boundary is described in the
[verification design](daemon-auto-update-design.md).

After verification, the daemon selects the channel target and stages it through
`stageVerifiedUpdate`. Pending state is published only after staging and final
metadata persistence succeed. Neither failed staging nor failed persistence
authorizes activation of the checked target. A failed
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
