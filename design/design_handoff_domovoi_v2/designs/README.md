# Split export of Domovoi Desktop V2.dc.html

The source is over the 256 KiB read cap. It is split here at the `</x-dc>` boundary, which
is also the meaningful seam: part 1 is the template (what the surface draws), part 2 is the
logic class (the values it draws).

| Part | Contents |
|---|---|
| `Domovoi Desktop V2.part1-template.html` | doctype, helmet, tokens, `<x-dc>` markup through `</x-dc>` |
| `Domovoi Desktop V2.part2-logic.html` | `<script data-dc-script>`, the `Component` class, `data-props` |

Concatenating part 1 then part 2 reproduces the original byte for byte, with no separator.
Verified at export time, on every export.

```sh
cat "Domovoi Desktop V2.part1-template.html" "Domovoi Desktop V2.part2-logic.html" \
  > "Domovoi Desktop V2.dc.html"
```

## Checking a re-export on arrival

Structural properties, which survive a re-export:

- part 1 ends with `</x-dc>` and nothing after it
- part 2 begins with a newline then `<script`, and ends with `</html>`
- the seam carries no separator: the last byte of part 1 and the first of part 2 are adjacent
  in the original

This file deliberately carries **no byte counts and no destination paths**. Both are facts
the files themselves already hold, and a restatement here goes stale the next time the
design changes — which it has. Read the sizes off the parts; put them wherever the other v2
designs live.

```sh
pnpm design:revision --accept-new=<part1> --accept-new=<part2> --accept-new=<this README>
```

Additions need `--accept-new` once. A later re-export is a content change to files already
recorded, so it needs none.

Digest the parts, not the reconstruction. A concatenated file is derived, and digesting a
derived artefact is the vacuous-check shape: it would agree with whatever produced it.
