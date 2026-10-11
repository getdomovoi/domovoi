---
"@getdomovoi/ui": patch
---

The file revert confirmation names a checkpoint by its commit's first 8 characters, as the
checkpoint row does, instead of printing "checkpoint checkpoint-<id>". The client authorization
dialog names `domovoid pair --client <kind>` without a required-looking `--label` placeholder.
