---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/mobile": minor
"@getdomovoi/cli": minor
---

The name `domovoid pair --client <kind> --label <name>` keeps with a code now reaches the device.
The pairing payload carries it as an optional `suggestedName`, held to the device label bound
(1 to 128 UTF-16 units after trimming, no control characters), and only when `--label` was given,
so an unlabelled code encodes as before. The phone and tablet "Name this phone" field starts with
it when the device has no name of its own, and stays editable. `domovoi pair` without `--label`
uses it, else the hostname. The device still names itself: the daemon keeps whatever name the
device sends when it spends the code. The name travels in the QR and the paste line, so anyone
who sees the code sees it; it is text the operator typed, not a secret. A web browser types a
word code and has no name field, so nothing changes there.
