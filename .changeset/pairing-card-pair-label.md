---
"@getdomovoi/ui": patch
---

The pairing card's "The same code as" line prints a command `domovoid` runs as printed, on every
tab: `domovoid pair --client phone`, `domovoid pair --client tablet` or
`domovoid pair --client web`. `--label` is optional and only a suggested name, so the line needs
none. With `--client web` the command prints the bare word code the browser's connect page takes.
