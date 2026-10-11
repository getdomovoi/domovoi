---
"@getdomovoi/cli": patch
---

`domovoi` names the daemon side of pairing as `domovoid pair --client cli` in its help, in the
message for a daemon it is not paired with, and when a pasted line is not a pairing code. The
daemon's `--label` is optional and only a suggested name, so the line no longer carries a
`--label <device label>` placeholder. `domovoi pair --label` still names this device.
