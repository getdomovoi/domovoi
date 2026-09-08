# Experimental relay vectors

This directory is test tooling. It has no production export and is outside the
protocol package's `dist` build and published files. The noble packages are exact
development dependencies. Do not import this codec from production code.

`cacophony-ik.json` contains the complete vector selected by
`protocol_name == "Noise_IK_25519_ChaChaPoly_SHA256"` from
[Cacophony's published vectors at 8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/vectors/cacophony.txt).
The full upstream source file has SHA-256
`3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`.
The `_source` header records that immutable revision and the full source digest
inside the fixture. Excluding this added metadata, the selection was compared
structurally against that source. Object key order and whitespace differ; all
upstream field values are unchanged. Its upstream license is
the [Unlicense](https://github.com/centromere/cacophony/blob/8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247/LICENSE).
These published private keys are public fixtures. Never use them for a connection.

`noise-ik.ts` implements only the candidate IK pattern from
[Noise revision 34](https://noiseprotocol.org/noise.html), using noble primitives.
It is an unaudited composition for this experiment. `vector-cases.ts` holds the
shared assertions; neither runner mocks the primitives or generates the expected
bytes. `vector-entry.ts` is an optional Metro/hermesc compilation entry.

See [the evidence and remaining gates](../../../../docs/relay-crypto-spike.md)
before making any production crypto or schema decision.
