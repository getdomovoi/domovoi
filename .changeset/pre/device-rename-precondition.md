---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Give `device.rename` an optional `expectedLabel` precondition. When present, the
daemon renames only a row whose label still reads that way, in one conditional
update, and otherwise refuses with `deviceLabelMismatchErrorCode` (`-32017`) and
a `device-label-mismatch` payload carrying the row as it stands. A rename without
the field is unchanged. Undo in the paired devices table sends the label its own
rename produced, so a rename from another client in between is kept: the row
shows the current name, the Undo offer is dropped, and the device action alert
says the name was changed elsewhere.
