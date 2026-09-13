# Relay IK codec

Frozen wire composition: `Noise_IK_25519_ChaChaPoly_SHA256`, Noise revision 34.
External review is pending. Changes to the frozen composition require a
compatibility break. Read [the byte contract and integration limits](../../../docs/relay-wire-format.md).

`@getdomovoi/protocol/relay` exports only the noble codec and its suite constant.
`noise-ik.ts` contains the composition; `index.ts` is the public boundary.
Keys and prologue are supplied by the caller. This module does not generate
keys, admit a paired device, create a relay server or enable a network transport.
The Domovoi admission layer must enforce empty handshake payloads and keep the
bearer in the first transport record. The generic codec also accepts payloads
for Noise vector interoperability; that alone is not the relay profile.

`testing/` is excluded from the build and published files. Its Node crypto oracle
supports suite A only, for comparison tests. There is no runtime backend switch.
`testing/vector-cases.ts` supplies the same runner-neutral assertions to protocol,
daemon and mobile tests. `testing/vector-entry.ts` is an optional Metro/hermesc
compilation entry, not execution evidence on Hermes.

`testing/cacophony-ik.json` is the complete suite-A selection from
[Cacophony at 8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt).
The upstream source file has SHA-256
`3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`.
The `_source` header records the revision and full source digest; all selected
upstream field values are unchanged. The fixture has also moved byte-for-byte
from the experiment, without recomputing any expected ciphertext or hash.
Its upstream license is the
[Unlicense](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/LICENSE).
These private keys are published test data. Never use them for a connection.
