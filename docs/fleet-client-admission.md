# Fleet client admission

Status: Desktop origin admission, Fleet Use and Terminal, and admitted inventory fan-out are
implemented. A real Electron run against two production-built daemons exercises the whole path.
Credentials stay in app memory. Remote Desktop preview frames are outside this socket grant.

## Two credentials, two authorities

Enrollment stores a machine-bound credential in the source daemon's keychain. On the target,
that credential identifies the source machine. It permits the machine RPC allowlist, including
heartbeat and transfer, not session sends, approvals, terminals, or issuing other credentials.
It must never be handed to a renderer or promoted to client authority.

A client credential is a separate bearer issued by the target's operator. It is bound to a
device id and one client kind: desktop, web, tablet, phone, or cli. It grants ordinary session
sends, approvals, and terminals. It does not grant device management or fleet enrollment.
Anyone holding it can exercise that authority until the target revokes or rotates it. Its label
is presentation, never identity. Durable decisions use the verified device id as the actor.

The daemon root credential is broader authority. It must not be used for remote client
admission. The client verifier explicitly refuses a root receipt even though root hello works.

## Operator grant

On the target machine, using its own daemon credential:

```sh
domovoid pair --client desktop --label "My desktop"
```

Use `web` for a browser client. This prints the new client bearer and the device id to revoke.
The command greets as cli and requests `targetClient: desktop`; the issuer's identity is not
changed to impersonate the recipient. Plain `domovoid pair` still issues a machine pairing code.
Machine pending claims and their expiration/confirmation rules are unchanged.

This is a deliberate grant, active when issued, not an automated machine claim. The target's
Devices list can revoke it even if the caller loses the reply. Check that list before retrying
an ambiguously completed grant. Do not paste a machine secret or a daemon root token instead.

## Protocol and client boundaries

- `device.pair`: existing `{label, client}` plus optional `targetClient`. Omission preserves the
  existing behavior. Only the target's root-authenticated connection can issue the grant.
- `device.current {}`: caller-only receipt, either `{kind: daemon, machineId}` or
  `{kind: client, machineId, deviceId, client}`. Identity comes from the verified credential, not
  hello presentation fields. Machine credentials cannot call it.
- `fleet.clientRoute {machineId, allowSourceLocal?}`: the source verifies a route through its
  existing machine dialer and returns `{outcome: ready, machineId, transport}` or a typed refusal.
  It never returns a credential. Eligibility uses the uncapped registry lookup with pending
  operations masked, keychain availability, health, protocol, and authenticated target identity.
- `allowSourceLocal` defaults false. Only a client on the source machine can use its loopback,
  WSL, or local SSH routes. An off-host client must not mistake that localhost for its own.
- `DomovoiClient` accepts `admission: {machineId, deviceId?}`. Every connection, including every
  reconnect, verifies hello identity and the client receipt before exposing the snapshot.
  The first admission records the returned device id; later connections pin it too.

Route discovery reuses existing transport ordering, WSL production discovery, and per-attempt
budgets. Client open, hello, and the receipt share one caller-owned deadline. Identity or authority
refusals stop fallback. Intermediate notifications wait in a queue bounded to 128 messages and
4,194,304 UTF-16 code units; overflow refuses verification instead of exposing partial state.

The new RPCs and optional field are additive. Protocol wire version remains 0.5.0. The changeset
is a patch under the pre-1.0 release policy, with no credential migration or re-pair.

## Fleet controls and refusals

The client error is `ClientAdmissionError` with a stable `reason` and local remedy copy. Remote
error strings are not displayed because they can echo a submitted secret. Reasons distinguish
missing enrollment, daemon pairing, inaccessible keychain, protocol or identity mismatch,
unusable route, route deadline, wrong client credential, and unavailable verification.

The Fleet action is **Authorize this client**, beside disabled Use and Terminal, with
the exact target command, authority warning, and inline remedy on refusal. Controls become usable
only after a successful identity/credential proof. The row says **Client credential verified** and
then offers Use and Terminal. The home connection remains available; **Return to home daemon**
works even while the remote connection is unavailable. Each remote reconnect verifies identity
and the same device id again. A known refusal removes local access and restores the remedy.

Opening Skills invokes bounded inventory fan-out using each machine's admitted client authority,
never the machine keychain. Each inventory reader independently verifies its client receipt and
closes after the answer. A verified pairing route remains usable even without advertisements.
Machines without admission are reported as unknown, not silently omitted or dialed with a machine
credential. Comparison carries metadata, not skill files, review authority, or enablement.

App-memory retention is the alpha scope, not durable storage: closing or reloading the app loses
its local copy, but does not revoke the grant on the target. Removing local access closes its
connections and explains that the operator still revokes the device in the target's Devices list.
Changing the home daemon or forgetting the enrolled machine also drops that local access.
Durable OS-keychain storage would need its own lifecycle decision.

## Exact-origin Desktop bridge

The main document keeps its loopback and acquired-home `connect-src`. It does not gain unrestricted
`wss:` or renderer-authored remote URLs. Trusted main-frame IPC accepts a machine id and a remaining
budget. Electron main calls `verifyLocalFleetClientRoute` through the acquired home daemon with
its home credential. The daemon uses its machine credential to authenticate the enrolled target;
neither credential crosses into the remote client socket.

Main grants one opaque, single-use ticket for a worker script response. That response has its own
`default-src 'none'; connect-src <exact origin>` policy. Only then does the worker open the remote
client socket. The ticket expires after 30 seconds, at most 128 tickets are retained, and removing
access invalidates unused tickets and in-flight verification. A different port, host, unverified
route, or replayed ticket remains blocked. Every new connection requests a fresh verified route.
The bridge itself does not prove client authority; the hello and `device.current` exchange does.

The packaged renderer uses `domovoi-app://desktop`, a restricted bundled-resource protocol. The
real Electron experiment found response-header CSP unenforced for `file://` resources. Serving
the app and worker through this origin makes the response policy enforceable without reloading
the renderer or dropping drafts. The loader refuses outside paths, other app hosts and methods,
and unsupported resource extensions. The app origin is accepted explicitly by the daemon, not
through a wildcard origin rule.

The default daemon origin list includes `domovoi-app://desktop`. If the operator overrides
`DOMOVOI_ALLOWED_ORIGINS`, include that exact origin and restart the daemon before using this
Desktop build. Explicit origin lists are not silently widened.

Existing `file://` browser-local appearance, layout and first-run preferences are not migrated
to the app origin. An existing development profile may need those preferences selected again.
Canonical sessions, provider configuration and paired devices remain in the same daemon profile.

Only loopback may use plaintext WS; remote routes require WSS. Literal IPv6 hosts are refused at
this Desktop CSP seam; configure a TLS hostname or usable IPv4 route instead. IPv6 route support
elsewhere does not make that CSP form safe to grant.

Socket admission grants no HTTP preview-frame access. On a remote Desktop session the Preview
tab explains that RPC and Terminal work but previews need a separate verified path, and names
opening the target's own app as the remedy. It issues no preview capability or iframe. Home
previews keep the exact home HTTP origin. This branch does not broaden frame sources, transfer
secrets to a relay, or add accounts or other Goal 3 services.

## Evidence at this checkpoint

Protocol tests cover additive parsing and strict caller receipts. Two production-built daemons
exercise separate client/machine authority and pending-forget route masking over real sockets.
The real CLI binary issues a desktop grant that the real shared client verifies over a socket.
Client tests refuse wrong identities, wrong kinds, root receipts, changed device ids, and missing
verification; they cover notification withholding, bounded queues, deadlines and reconnects.

`pnpm --filter @getdomovoi/desktop test:launch` includes two real Electron proofs:

- `fleet-origin-smoke.mjs`: verified origin opens; an unverified origin, another port, and a
  consumed ticket do not. Replacing the exact source with a port wildcard makes the proof fail.
- `fleet-client-smoke.mjs`: the actual main, preload and renderer attach to a real home owner,
  authorize a separate target client grant, open its session and terminal, read inventory with
  the verified client receipt, render the comparison, and remove local access. The keychain and
  provider are test adapters; lease, owner discovery, Git, SQLite, enrollment and sockets are real.
  No billable provider turn runs. Both proof and child cleanup waits have finite budgets.

Mounted UI tests keep controls disabled before the receipt, show the root-credential refusal,
keep the home connection alive, and withdraw access after revocation. Removing the parent
authorization action made the mounted proof fail. The real Electron proofs have passed locally
on Linux; macOS and Windows execution awaits CI. This does not prove OS-keychain retention, remote
HTTP previews, multi-distro routing, or reachability across arbitrary private networks.
