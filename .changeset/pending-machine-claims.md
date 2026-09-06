---
"@getdomovoi/daemon": minor
"@getdomovoi/protocol": minor
---

Keep machine-pairing claims pending for five minutes instead of activating a remote credential
before the source can store it. The source journals the claim and verifies durable keychain
readback before confirming activation. Pending credentials cannot authenticate, and an abandoned
re-pair does not revoke the previous active credential. Lost confirmation replies recover
idempotently after restart; unconfirmed claims expire without ever granting normal authority.

The wire moves to protocol 0.5.0. Update peers together before enrollment. Existing active bound
credentials remain valid and do not need re-pairing. If an unfinished claim expires, issue a new
code on the target and enroll again. Transport or storage ambiguity remains pending for retry.
