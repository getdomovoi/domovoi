---
"@getdomovoi/protocol": minor
---

A repository's trust state can now say that it cannot be trusted, whatever the person approves,
because its agent would load input the configuration digest does not cover. The state lists each
refusal by provider, code (`nested-config`, `main-checkout-hooks`, `main-checkout-unknown` or
`instructions-outside`) and redacted path, at most 32 of them, and counts the rest in
`omittedRefusals`. It pins to no digest. `repository.trust` gains a `cannot-trust` outcome for
such a repository, in which nothing is granted, and `repository.revokeTrust` may report a
repository in this state. Paths and provider names are held to the same rules as the tool
inventory's text, which now lives in one module both use.
