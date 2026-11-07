---
"@getdomovoi/daemon": patch
---

The repository trust store now accepts its table only when the table's indexes are exactly the two it
creates: the primary key's index and `repository_trust_trusted_at` on `trusted_at`, each comparing
its key as bytes, and each belonging to the table. Any other index refuses the table, even one that
compares bytes. Before, the store looked each listed index up by name. An unqualified name found a
temporary index of the same name first; a table or virtual table named `pragma_index_xinfo`, in any
schema, answered for the lookup function; and an index name stored as invalid UTF-8 read back as
U+FFFD, and looking that text up found a different index. Each let an index that compares project
ids without regard to case pass. The store now reads keys only for its two fixed index names, from
the main schema, with the `PRAGMA main.index_xinfo` statement, and an index with no key column
refuses the table.
