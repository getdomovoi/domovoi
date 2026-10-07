---
"@getdomovoi/ui": patch
---

The pairing card's "The same code as" line now prints a command `domovoid` runs as printed:
`domovoid pair --client phone --label Phone`, `--client tablet --label Tablet`, or
`--client web --label Browser`. The line used to stop at `--client <kind>`, which `domovoid pair`
refuses with its usage text and exit status 1, because the client form needs `--label`.
