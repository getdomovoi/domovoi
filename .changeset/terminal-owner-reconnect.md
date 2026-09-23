---
"@getdomovoi/daemon": patch
---

A terminal's owner keeps it across a reconnect. Ownership now follows the client a direct connection authenticated as (its hello identity, or its paired device), not only the socket: when the owner reconnects, the daemon hands the terminal back at the hello and announces it with `terminal.ownership`, so it is not reaped after 30 seconds just because the terminal pane was not open, and a new connection that attaches before the old one has closed can type instead of being refused as another client. Another client is still refused, an abandoned terminal is still reaped, and relay channels stay bound to the channel that admitted them.
