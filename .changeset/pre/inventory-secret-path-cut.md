---
"@getdomovoi/protocol": patch
"@getdomovoi/daemon": patch
---

The tool inventory no longer shows a secret path in a command. A flag that says where a token,
key, secret, password or credential lives (`--token-file`, `--password-file`, `--ssh-key-path`,
`--key-file` and the like, as `--flag value` or `--flag=value`) is a trigger: the reader cuts the
text there, as it does at a sensitive flag. The protocol exports `isCredentialLocationKey` and the
`locationSuffixes` rule, and its backstop refuses a value after such a flag. In a command line or
argument vector, the reader also cuts at the first argument that names a known credential store
or secret file, judged by the same classifier the hard gate uses. A rule such as `Read(./.env)` is
not a command and keeps its path.
