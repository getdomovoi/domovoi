---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": patch
---

A receipt now names the paired device that decided. The receipt thread item and the approval
history entry carry an optional `device`, the device's id and label in the shape a terminal owner
names it, bounded like a paired device label. The daemon writes it from the device record it
verified on the deciding connection, when a person allows or denies a gate, reverts a file,
archives a session or presses the emergency stop; a connection on the daemon credential has no
paired device and writes none, and an archive resumed at startup has no connection and writes
none. Renaming the device later does not rewrite a receipt.

The web and desktop receipt reads the label from the wire, before the client kind, as
`decided from dana · phone, connection ...`; history rows read `decided on dana · phone`. A
receipt without a device, from the daemon credential or a snapshot written before the field,
reads as before.
