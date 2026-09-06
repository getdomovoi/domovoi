# Fleet client admission

Status: daemon and client verification foundation. Fleet Use, Terminal, inventory fan-out, and
Desktop origin admission are not wired by this checkpoint. No roadmap outcome is closed yet.

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

## Refusals and remaining interface work

The client error is `ClientAdmissionError` with a stable `reason` and local remedy copy. Remote
error strings are not displayed because they can echo a submitted secret. Reasons distinguish
missing enrollment, daemon pairing, inaccessible keychain, protocol or identity mismatch,
unusable route, route deadline, wrong client credential, and unavailable verification.

The intended Fleet action is **Authorize this client**, beside disabled Use and Terminal, with
the exact target command, authority warning, and inline remedy on refusal. Controls become usable
only after a successful identity/credential proof. Inventory fan-out must use that same admitted
client authority, never the machine keychain. Those surfaces are not implemented yet.

App-memory retention is the proposed alpha scope, not durable storage: closing the app loses its
local copy, but does not revoke the grant on the target. Removing local access must explain that
the operator still revokes the device in the target's Devices list. Durable OS-keychain storage
would need its own lifecycle decision.

Desktop currently permits only loopback and the acquired home endpoint in `connect-src`. A
remote TLS route is therefore blocked even after credential verification. Do not replace that
boundary with unrestricted `wss:`. The proposed integration is a narrow Desktop origin-admission
bridge: main verifies the enrolled route through the home daemon, authorizes only that exact
origin, and keeps other remote origins blocked. That security-policy seam needs agreement before
the Fleet controls are wired. No accounts, hosted relay, or Goal 3 service is required.

## Evidence at this checkpoint

Protocol tests cover additive parsing and strict caller receipts. Two production-built daemons
exercise separate client/machine authority and pending-forget route masking over real sockets.
The real CLI binary issues a desktop grant that the real shared client verifies over a socket.
Client tests refuse wrong identities, wrong kinds, root receipts, changed device ids, and missing
verification; they cover notification withholding, bounded queues, deadlines and reconnects.
These are not yet an end-to-end proof of Fleet Use or Terminal in the shipped Desktop interface.
