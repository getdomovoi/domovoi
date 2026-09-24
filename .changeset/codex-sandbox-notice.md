---
"@getdomovoi/daemon": patch
---

When a session starts on Codex, is handed off to Codex or is forked to Codex, the thread now says
that the Codex sandbox refuses reads of `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`,
`.netrc` and `.pypirc`, and that a test or build that loads `.env` fails with "Operation not
permitted". Codex emits nothing for a refused command, so Domovoi also starts each Codex thread with
developer instructions that name those files and ask the model to say so in its reply when a
command fails on one of them.
