---
"@getdomovoi/cli": patch
---

The decision receipt line in `src/transcript.ts` names the decider by the paired device the
daemon wrote on the receipt, label before client kind, as the web and desktop receipt reads:
`allowed once by dana's phone · phone on mac-mini-m4 · 14:07:11`. A receipt without a device (the
daemon credential, or a row written before the field) keeps the label the caller supplies, and
with none names the client kind alone. No command prints the line yet.
