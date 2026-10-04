---
"@getdomovoi/cli": patch
---

CLI output now shows control characters, bidirectional formatting characters and line separators
in machine names, labels, reasons, paths and messages as visible escapes (`\n`, `\e`, `\u{202e}`
and so on), so a value can no longer break a line, restyle the terminal or reorder the fields
around it. This covers `pair`, `status`, `doctor`, `logs`, `skill install`, the credential file
warning, every error printed to stderr, and the gate and policy refusal lines in
`src/transcript.ts`. Ordinary text in any script is unchanged.
