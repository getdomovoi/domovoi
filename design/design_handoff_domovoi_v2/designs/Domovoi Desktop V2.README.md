# Split export of Domovoi Desktop V2.dc.html

The source file is 292,920 bytes, over the 256 KiB read cap. It is split
here at the `</x-dc>` boundary, which is also the meaningful seam: part 1 is the template
(what the surface draws), part 2 is the logic class (the values it draws).

| Part | Bytes | Contents |
|---|---|---|
| `Domovoi Desktop V2.part1-template.html` | 159,742 | doctype, helmet, tokens, `<x-dc>` markup through `</x-dc>` |
| `Domovoi Desktop V2.part2-logic.html` | 133,178 | `<script data-dc-script>`, the `Component` class, `data-props` |

Concatenating part 1 then part 2 reproduces the original byte for byte, with no separator.
Verified at export time.

```sh
cat "Domovoi Desktop V2.part1-template.html" "Domovoi Desktop V2.part2-logic.html" \
  > "Domovoi Desktop V2.dc.html"
```

Vendor both parts and this README, so the reconstruction rule travels with them:

```sh
pnpm design:revision \
  --accept-new=design/design_handoff_domovoi/designs/desktop-v2.part1-template.html \
  --accept-new=design/design_handoff_domovoi/designs/desktop-v2.part2-logic.html \
  --accept-new=design/design_handoff_domovoi/designs/desktop-v2.README.md
```

Digest the parts, not the reconstruction. A concatenated file is derived, and digesting a
derived artefact is the vacuous-check shape: it would agree with whatever produced it.
