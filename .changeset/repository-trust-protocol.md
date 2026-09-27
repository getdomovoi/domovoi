---
"@getdomovoi/protocol": minor
---

Adds repository trust to the protocol. Trust is recorded per machine and per repository, and it
is pinned to the digest of the repository's provider configuration files that the person
reviewed. A trust state is not trusted, trusted with the digest it covers, or not trusted because
the configuration changed since it was trusted, which keeps the earlier grant for review. A
trusted state whose digest is not the current one is refused. The tool inventory's repository now
carries its trust state.

`repository.trust` takes the project and the digest the client showed, and answers either trusted
or that the configuration changed, with the repository's current digest and state.
`repository.revokeTrust` leaves the repository not trusted and lists each session whose agent
thread it restarted, or whose old thread it could not confirm stopped. Both are control methods
that change stored state. Only desktop and web clients call them: phone and tablet credentials do
not get them, and a grant names a desktop or web client. Neither method has a field for another
machine, the fleet or a hard gate, so trust never skips a hard gate. The daemon does not answer
them yet.
