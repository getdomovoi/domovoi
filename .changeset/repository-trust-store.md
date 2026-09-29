---
"@getdomovoi/daemon": patch
---

The daemon now records repository trust and answers `repository.trust` and
`repository.revokeTrust`. It keeps one grant per repository on this machine in its state database,
with the configuration digest the grant covers, when it was granted, and which client granted it.
The client comes from the connection's credential: the owner's bearer credential is recorded as
desktop with no client id, and a paired desktop or web credential as its own client with its device
id. At most 512 grants are kept; the oldest beyond that are dropped, which leaves those
repositories not trusted. A stored grant the protocol would refuse reads as no grant. A grant, the
trim to the cap and a read back of the grant commit together or not at all. A table under the
store's name that is not the one it creates, or that has a trigger on it, yields no grant and
takes none; that includes a table named in another case, a trigger naming the table in another
case, a generated or hidden column, and an index that compares project ids other than byte for
byte. A grant is read and revoked only for the exact project id. When a failed grant cannot be rolled back, the store reads
and records no grant for the rest of the daemon's run, and rolls back the transaction it opened. A revocation that leaves the grant stored fails with the internal error rather than
reporting the repository not trusted. An emergency stop during a trust request's configuration
read cancels it: nothing is recorded, and it is answered like any cancelled operation.

`repository.trust` reads the open repository's configuration now. When the digest the client sent
is not the current one it records nothing and answers `config-changed` with the current digest and
state. When the repository holds input the digest does not cover, it records nothing and answers
`cannot-trust` with the reader's refusals. Otherwise it records the grant and answers `trusted`.
`repository.revokeTrust` removes the grant and reports the repository not trusted, with no threads
listed, since nothing loads under trust yet. Both refuse a project other than the open one with
"Repository trust applies only to the open project". A reader failure is answered with the daemon's
internal error, which names no path or value.

`tool.inventory` now reports the repository's real trust: trusted when the grant's digest is the
current one, not trusted because the configuration changed (with the earlier grant) when it is
not, not trusted with no grant, and cannot be trusted, with its refusals, when the reader refuses
it. Trust is recorded, not applied: sessions still start with the repository's configuration kept
back as before, and no inventory entry is marked held back.
