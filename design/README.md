# design/

Signed sources from Claude Design that this repository does not author. Nothing
here is edited in place. When Claude Design publishes a revision, the files are
re-vendored and `design/REVISIONS.json` is regenerated with `pnpm design:revision`,
which records a digest per file so a local edit and a genuine upstream revision
cannot be mistaken for one another.

- `design_handoff_domovoi/`, `design_handoff_domovoi_brand/` the product and
  brand handoffs. Recreate them in the production stack; do not port their
  prototype markup or `support.js`.
- `design_system_domovoi/` the design system: tokens, stylesheet, readme, and
  the specimen cards under `guidelines/`.

## `_adherence.oxlintrc.json` is data, and no linter reads it

`design_system_domovoi/_adherence.oxlintrc.json` is vendored as a **manifest**,
not as lint configuration. This repository does not install oxlint, and the file
is wired to nothing.

It is here for `x-omelette.tokenKinds`, which names the kind of every token.
`scripts/design-rule.mjs` reads it, together with `tokens/typography.css`, to
generate the lint rule that enforces the small-type floor, deriving the boundary
from the tokens rather than restating it. Its sibling `x-omelette.tokens` lists
the same names without kinds and nothing reads it today; it is vendored because
the file is vendored whole. Vendoring the manifest is also what makes an
upstream token change visible: it fails `pnpm design:revision --check` like
every other file here.

Its own rules are not used and would not work if they were. Every one is a
warning rather than an error, and its raw-pixel selector matches the `5px`
inside `9.5px`, so it flags the values the design system itself defines.
