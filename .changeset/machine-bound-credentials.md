---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Bind every paired credential to one exact client kind or machine identity. The
authenticated actor now comes from that binding, not from identity fields a
caller sends after connecting, so audit entries, approvals, plan edits, and
transfer decisions cannot be attributed to a different client. Device activity
is recorded only after an accepted hello.

This is a breaking wire change and moves the shared protocol to 0.3.0. Older
peers fail at the handshake instead of agreeing to talk and then failing inside
a call. Transfer wire assertions are now named `initiatedByClient`, and the
retired pre-contract transfer RPC family is removed.

One migration handles both legacy shapes: credentials that could act as either
a machine or a person, and client credentials that did not record a client
kind. Any such pairing is revoked once and must be made again. The paired-device
list preserves why it was retired, while authentication remains deliberately
uniform so it does not reveal whether a presented credential ever existed.

Daemon and device credentials are now fixed-width 256-bit base64url values. A
configured daemon credential in the older weak shape is rejected at startup
with an actionable error. A paired client credential grants ordinary client
authority, including sending or steering work, answering approvals, and using
terminals, so it must be protected as an account-equivalent secret.
