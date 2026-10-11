---
"@getdomovoi/cli": patch
---

Stop declaring `@napi-rs/keyring` in the CLI. The CLI reaches the OS keychain only through
`@getdomovoi/credential-store`, which declares and loads the binding itself, so the CLI no longer
carries a second version range for it to keep in step.
