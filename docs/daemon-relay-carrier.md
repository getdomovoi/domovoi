# Daemon relay carrier

The production daemon optionally reads `relay-carrier.json` from its selected
profile directory while holding the profile lease. Without that file it remains
direct-only. This is an operator-configured outbound WSS transport for carrier v1;
it does not issue routes, invite grants, account claims or registration credentials.
The O8 provisioning and account policy decisions remain separate.

The daemon sends its existing, validated `relay.recovery` publication only after
the WSS handshake verifies the certificate, hostname and expiry. Redirects,
userinfo, query parameters, compression and custom verification callbacks are
not accepted. Normal system trust applies unless `ca` explicitly supplies a PEM
trust anchor. Setting `ca` does not disable hostname or expiry verification.

## Configure an existing route

1. Provision the daemon's channel identity using
   [relay key provisioning](relay-key-provisioning.md), with no carrier file, then
   stop the daemon. Keep the cold identity signing key off this machine.
2. Obtain an operator-provisioned route, its independent registration credential
   and the relay authority's current generation floor for this exact machine.
   Zero is appropriate only when that authority confirms a never-used route.
   This guide does not define an issuer, registry or restore/reprovisioning policy.
3. In the private profile directory, create mode-0600 `relay-carrier.pending.json`
   with the following shape. Replace the two credential placeholders and endpoint
   locally. The policy numbers below are an example for a local qualification
   environment, not a hosted operational policy. Select finite budgets appropriate
   for the intended relay before using it.

```json
{
  "version": 1,
  "url": "wss://relay.example/carrier",
  "routeId": "OPERATOR_ROUTE_ID",
  "registrationCredential": "INDEPENDENT_OPERATOR_CREDENTIAL",
  "policy": {
    "connectTimeoutMs": 10000,
    "registrationTimeoutMs": 10000,
    "sendTimeoutMs": 5000,
    "maximumAttempts": 10,
    "retryBaseMs": 1000,
    "retryMaximumMs": 30000,
    "heartbeatIntervalMs": 15000,
    "heartbeatTimeoutMs": 10000,
    "maximumChannels": 32,
    "maximumQueuedBytes": 1048576,
    "maximumQueuedMessages": 64
  }
}
```

4. Initialize the generation record with the confirmed floor. The script below
   is for first setup only: it refuses existing active configuration or generation
   state. Run it with the daemon stopped, after setting `RELAY_PROFILE` to the
   selected private profile directory and `RELAY_KNOWN_FLOOR` to the confirmed
   nonnegative integer. Neither variable contains a credential. Do not run this
   as a reset procedure or delete an existing record to make it succeed.

```sh
node --input-type=module - "$RELAY_PROFILE" "$RELAY_KNOWN_FLOOR" <<'JS'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
const [profile, rawFloor] = process.argv.slice(2)
const generation = Number(rawFloor)
if (!profile || !isAbsolute(profile) || !/^(0|[1-9][0-9]*)$/.test(rawFloor ?? '') ||
    !Number.isSafeInteger(generation) || generation >= Number.MAX_SAFE_INTEGER) throw Error('Invalid profile or confirmed floor')
const pending = join(profile, 'relay-carrier.pending.json')
const active = join(profile, 'relay-carrier.json')
const state = join(profile, 'relay-generation.json')
if (existsSync(active) || existsSync(state)) throw Error('Existing carrier state requires operator recovery')
const config = JSON.parse(readFileSync(pending, 'utf8'))
const { identity } = JSON.parse(readFileSync(join(profile, 'relay-identity.json'), 'utf8'))
const binding = createHash('sha256').update(JSON.stringify([
  new URL(config.url).href, config.routeId, identity.machineId, config.registrationCredential,
])).digest('hex')
writeFileSync(state, JSON.stringify({ version: 1, binding, generation }), { flag: 'wx', mode: 0o600, flush: true })
const flushDirectory = () => {
  if (process.platform === 'win32') return
  const fd = openSync(profile, 'r')
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
flushDirectory()
const pendingFd = openSync(pending, 'r')
try { fsyncSync(pendingFd) } finally { closeSync(pendingFd) }
renameSync(pending, active)
flushDirectory()
JS
```

5. Restart the daemon through its existing operator-managed launch path. No
   new service, CLI enrollment command or secret environment variable is added.

Keep the parent directory private and trusted. Configuration reads are bounded
to 64 KiB and generation reads to 2 KiB. Unix file permissions must exclude group
and other access; Windows mode bits are not an ACL proof. The daemon refuses a
registration credential equal to its root bearer, channel private key, route ID,
or any currently active locally paired client or machine bearer. The operator
must also ensure independence from credentials held by other machines or systems.

## Generations, reconnects and refusal

Every physical connection reserves and persists a strictly newer registration
generation before dialing. The SHA-256 binding covers canonical URL, route ID,
machine ID and registration credential. It is independent of the signed channel
identity generation. A concurrent owner, missing or malformed state, changed
binding, exhaustion or uncertain publication refuses. Stop waits for a pending
reservation before releasing the exclusive generation lease.

An acknowledged file publication flushes contents and, on POSIX, directory
entries. The existing Windows publication helper does not flush directory
entries, so Windows power-loss durability is not promised. A restored or stale
floor remains subject to the relay's remote generation fence. Do not repeatedly
increment toward an unknown remote floor or reset to zero: stop, preserve the
records, and obtain an authenticated operator recovery decision for the current
route and floor. Credential or route changes likewise require explicit recovery.

Network loss and missing heartbeat responses cause bounded retries with equal
jitter. `maximumAttempts` counts all physical attempts during this carrier's
lifetime, including successful connections; it is not reset by acknowledgment.
Exhaustion requires an operator restart after inspecting the cause. Invalid TLS,
malformed carrier traffic and capacity violations refuse. A secure connection
that closes before registration acknowledgment also refuses: carrier v1 provides
no typed refusal, so the daemon cannot distinguish credential revocation, a stale
generation, relay admission limits or a lost acknowledgment. It does not label
that ambiguity as a diagnosed account or credential failure.

The daemon logs only a refusal category. Carrier refusal leaves the direct daemon
available; invalid local configuration or generation storage instead fails startup
and the production wrapper closes its listener and releases ownership. Changing
configuration requires a restart. JavaScript credential strings cannot be reliably
wiped from memory.

Channels open only after the matching registration acknowledgment. Each opens
the existing daemon Noise admission path, which still requires a paired credential
bound to the client's channel key. Physical retirement closes all channels and
discards pending frames. A replacement connection requires fresh admission; no
RPC mutation is replayed. Closed channel IDs discard late frames, while unknown
or reused IDs refuse the physical carrier. Queue bytes include the in-flight
message; message count, channel count, fragment count, connection and send
deadlines are bounded. Heartbeats use that same bounded queue.

Tests use isolated profiles, a synthetic TLS certificate with normal validation,
and real endpoint encryption/admission/RPC. They do not establish hosted relay,
multi-day network, mobile background or native service qualification.
