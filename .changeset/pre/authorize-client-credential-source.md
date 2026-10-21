---
"@getdomovoi/ui": patch
"@getdomovoi/desktop": patch
---

The Authorize this client dialog no longer tells the person to run `domovoid pair --client <kind>` and paste its output as the client credential. That command prints a one-time pairing code, which the field does not take. The dialog now says a client credential comes from a device.pair request made with the machine's own daemon credential.
