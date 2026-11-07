---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Verify skill signatures against a local trust file. A `SKILL.md.sig` whose Ed25519 signature
over the content digest verifies against a key in `~/.domovoi/skill-trusted-keys.json` now yields
a trusted state; a key the file does not list stays unverified, and a failing signature or content
changed since signing is blocked. `domovoid skill keygen`, `sign`, and `trust` create a signing
key, sign a skill, and add a public key to the trust file. The delivery record on a sent turn
carries the trust state each delivered skill had, and the skill browser names an untrusted key.
