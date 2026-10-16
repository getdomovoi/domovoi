---
"@getdomovoi/protocol": minor
---

A `repository.revokeTrust` result can count the threads it stopped and did not list. A revoke
stops every thread that loaded the repository's trusted configuration, however many there are. It
lists at most `maximumRepositoryTrustThreadRestarts` (1,024) in `threads`, and `omittedThreads`
counts the rest. The field is a positive integer present only when at least one thread was left
out, so a client never presents a cut list as the whole of it.
