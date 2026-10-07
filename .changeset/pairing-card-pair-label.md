---
"@getdomovoi/ui": patch
---

The pairing card's "The same code as" line now prints a command `domovoid` runs as printed:
`domovoid pair --client phone --label Phone` or `domovoid pair --client tablet --label Tablet`.
The line used to stop at `--client <kind>`, which `domovoid pair` refuses with its usage text and
exit status 1, because the client form needs `--label`. The Web browser tab no longer names a
command: `domovoid pair --client web` prints a QR and a `domovoi-pair:` payload, and the browser's
connect page takes the bare word code alone.
