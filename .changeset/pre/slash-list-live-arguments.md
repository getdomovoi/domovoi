---
"@getdomovoi/ui": patch
---

The slash command list no longer shows the design's sample arguments ("ckpt_7f24", "hetzner-cx42",
"pr-triage" and a prisma command) as if they belonged to the session. `/revert` names this session's
latest checkpoint, `/skill` a reviewed skill and `/handoff` another machine when there is one;
otherwise each row shows the argument's shape, such as `<checkpoint-id>` or `<command>`.
