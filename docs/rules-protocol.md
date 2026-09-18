# Rules protocol

This is the protocol half of the v2 Rules tab. The product source is `rules` and
`neverRules` in the signed `Domovoi Desktop V2.dc.html` handoff. The tab
itself is not implemented here.

That file is 302,172 bytes and a DC file keeps its logic class at the end, so
`rules`, `neverRules`, the model short-name derivation, the usage rows and the
theme flip all sit in the last 40 KB. A read through the design tooling caps at
262,144 bytes and returns a prefix without saying so; the repository's vendored
copy under `design/design_handoff_domovoi_v2/designs/` is the whole file and is
the one to read for anything past the template. Vendoring it whole replaced the
two-part export that used to document this cap.

## Retire a rule

`approvalRule.revoke` takes `{ ruleId, client }` and returns the updated workspace
snapshot. It is a mutating RPC for authenticated clients. The daemon verifies
the claimed client against the connection, requires the rule to belong to the
open project, and derives attribution from that connection.

An active rule becomes inactive with `inactiveReason: "revoked"`, `inactivatedAt`,
`inactivatedBy`, `inactivatedByConnectionId`, and, when supplied at authentication,
`inactivatedByClientId`. Its execution record, creation attribution, and use count
remain. Revocation does not delete the rule. Existing replacement links remain
valid when the replacement is later revoked.

Repeating revocation preserves its original attribution and timestamp and retries
the durable write before acknowledging success. Legacy rules already inactive
for another reason are refused. Revocation prevents future rule matches, not an
operation already approved.

## Count uses

`approvalRuleSchema.useCount` is a nonnegative safe integer. A rule starts at zero.
Only a standing-rule preapproval increments it; explicit approvals, hard gates,
and independent Build Auto approvals do not. The daemon persists the increment
before sending the provider an approval. A failed write denies that request and
records a denied use in the audit log. A saturated count cannot preapprove again.

The count records preapprovals, not successful tool completions. A crash after
the durable write but before provider delivery can leave a counted preapproval
that the provider never received; this is not an exactly-once execution ledger.
Migrated rules start at zero because earlier use history was not counted.

## Render hard gates

`permission.hardGates` is a read-only RPC with empty params. It returns
`{ categories: [{ id, label }] }`, with bounded, validated IDs and plain-word
labels. Pattern groups in `permission-policy.ts` supply both the matching regexes
and the labels; the existing skill-installation check is included as a category.
Clients can render this data without copying the policy's list.

This exposes the current policy categories, not a new classifier. Matching
semantics are unchanged. In particular, it does not introduce production-database
classification or new-host-only network classification from the prototype copy.

## Compatibility

The wire minor is now 0.7.0 because older strict rule schemas reject the added
count and revoked variant. Clients and daemons must upgrade together. Stored
0.6.x workspaces migrate to 0.7.0, preserving active rules and adding zero counts;
the previously supported 0.3.x migration remains. Full snapshot validation runs
before the migrated state is written. No installer, relay, TUF, or reproducible
build behavior changes are included.
