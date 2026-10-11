---
---

Build tooling only: building the desktop daemon runtime restores the checkout's pnpm workspace
state that `pnpm deploy --prod` records, so the next `pnpm` command in the checkout neither aborts
nor reinstalls for production. CI runs the packaged service smoke from its package script again.
No released package changes.
