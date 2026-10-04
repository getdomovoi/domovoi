---
"@getdomovoi/cli": patch
---

CLI output now shows control characters, bidirectional formatting characters and line separators
in machine names, labels, reasons, paths and messages as visible escapes (`\n`, `\e`, `\u{202e}`
and so on), so a value can no longer break a line, restyle the terminal or carry a directional
override into the text after it. Ordinary right-to-left letters are printed as they are, so in a
viewer that applies bidirectional ordering they can still move a neighbouring field; only the
decision receipt line isolates its fields. This covers `pair`, `status`, `doctor`, `logs`, `skill install`, the credential file
warning, every error printed to stderr, and the gate and policy refusal lines in
`src/transcript.ts`. Ordinary text in any script is unchanged.
