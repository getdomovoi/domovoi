---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
---

A phone or tablet can read a terminal. Three read-only methods join the phone and tablet
allow-list: `terminal.list` names a session's terminals, `terminal.watch` returns what the
daemon kept of one (redacted before it was kept, at most 65,536 characters, with when that
record starts and whether earlier output was dropped) and then sends its live output, and
`terminal.unwatch` stops that. None of them reach the shell: `terminal.create`, `terminal.claim`,
`terminal.input`, `terminal.resize` and `terminal.close` stay refused to those credentials, so
the one claimant still types.

Terminal notifications now go to the connections that opened, claimed or watch a terminal,
not to every client. A closed terminal stays readable for one hour with its exit code, then is
dropped; the daemon holds it in memory only. The owner on the wire also names the paired
device the daemon verified on the claiming connection, id and label at claim time, when there
is one. The pairing card's unbuilt line is the short form, "Terminal output is not on a phone
yet."
