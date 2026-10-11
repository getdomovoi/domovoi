---
"@getdomovoi/mobile": patch
---

The phone follows a watched terminal's grid and ages fleet heartbeats by the daemon's clock.

A phone watch now asks `terminal.watch` with `followResize`, so the cols x rows it names follows the
holder's resizes as `terminal.resized` arrives, rather than waiting for the next list. The phone
draws text lines that wrap at its own width, so nothing else changes. A daemon from before the
notice refuses the field as invalid parameters, and the watch is asked for again without it. A late
answer to a watch asked before the person left and came back no longer ends the newer watch.

Machines and the Sessions fleet lines measure how long a machine has been silent from the
`daemonTime` of the fleet snapshot that carried its heartbeat, kept with that snapshot, so a phone
whose clock is off no longer calls a machine heard from minutes ago silent for hours. A daemon that
sends no time is measured on the phone's clock, as before. How long a session has waited on you is
still measured on the phone's clock.
