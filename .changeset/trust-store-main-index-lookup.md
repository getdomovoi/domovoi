---
"@getdomovoi/daemon": patch
---

The repository trust store now reads its table's columns and index keys from the main schema. Before,
an index was looked up by name without a schema, so a temporary index sharing a name with one of
the table's indexes was read in its place. A main index that compares project ids without regard to
case was then accepted when a temporary index of the same name compared bytes, and a valid table was
refused when a temporary index of the same name ignored case. Both now read the main index. Index
keys are read with the `PRAGMA main.index_xinfo` statement rather than the `pragma_index_xinfo`
function, which a table or virtual table of that name in any schema could answer for, and an index
with no key column refuses the table.
