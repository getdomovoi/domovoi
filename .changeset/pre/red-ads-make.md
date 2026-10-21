---
"@getdomovoi/desktop": patch
---

`THIRD_PARTY_NOTICES.txt` now names `tailwindcss` and `shadcn` with their MIT license text.
`@tailwindcss/vite` copies their CSS into the renderer stylesheet through the `@import` rules in
the UI stylesheet: Tailwind's preflight and generated utilities, and shadcn's `tailwind.css`. Both
are development dependencies of the UI, so the notices, which read production graphs, left them
out. The license audit now covers them too.
