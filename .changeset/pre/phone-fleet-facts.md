---
"@getdomovoi/mobile": patch
---

Give the phone's Fleet tab the facts it can stand behind. Every machine row now
says how it is reached, a machine that has stopped answering says when it was
last heard from, a daemon running inside WSL names its distribution, and the
title says how many machines answer and how many do not. The card for the daemon
this phone is connected to carries its session and tool counts, read from the
workspace snapshot it already holds; no other row gets them, because `fleet.list`
carries no counts for another machine. The phone also takes the daemon's
`fleet.changed` push, so a list on screen stops describing the moment the tab was
opened. Waking a machine and pairing one from the phone are still not offered,
because neither has a protocol call behind it.
