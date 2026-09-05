---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Add `device.rename`, which changes the label on a paired device or machine
credential row and nothing else. The request carries the device id and the new
label only; the row keeps its id, binding, credential, and timestamps, so a
rename can never move a machine identity or a credential. Labels are trimmed,
bounded like a pairing label, and refuse control characters. The daemon authorizes
the call like `device.revoke`, refusing a device credential, and records it in
the audit log against the device id. The paired devices table renames in
place, with Save and Cancel inside the field and Undo after a commit.
