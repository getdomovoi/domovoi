---
"@getdomovoi/daemon": patch
---

Terminal output no longer reaches phones and tablets. The daemon sent every terminal's
`terminal.output`, `terminal.ownership` and `terminal.closed` notifications to every connected
client, so a paired phone or tablet credential, including a watching-only one, received the live
bytes of any terminal the owner opened, although the pairing card says terminal output is not on a
phone. Those notifications now go only to the connections that opened the terminal with
`terminal.create` or took it with `terminal.claim`, and never to a phone, tablet or watching-only
credential. A connection that closes leaves the terminal's audience.
