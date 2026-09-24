---
"@getdomovoi/daemon": patch
---

Secret redaction now catches prefixed variable names such as `DOMOVOI_AUTH_TOKEN`, `NPM_TOKEN`,
`HF_TOKEN`, `DATABASE_PASSWORD`, `POSTGRES_PASSWORD` and `CLOUDFLARE_API_TOKEN`. The name patterns
required a word boundary right before the sensitive word, and `_` is a word character, so
`NPM_TOKEN=value` was stored, broadcast and shown on approval cards in clear, and a command
carrying one was not treated as containing a secret. A sensitive name may now carry an identifier
prefix in assignments, `export`, PowerShell `$env:`, `set "..."`, JSON-style keys, `--prefix-token`
flags and `-Dprefix.password=` properties, including npm's `//registry.npmjs.org/:_authToken=` and
`npm_config__authToken=`. `SECRET_KEY`, `DJANGO_SECRET_KEY` and `STRIPE_SECRET_KEY` are caught too.
A suffix still does not count, so `TOKEN_BUDGET=4096`, `TOKENIZERS_PARALLELISM=false` and
`SECRET_KEY_BASE` are left alone, and a negated flag such as `psql --no-password mydb` or
`mysql --skip-password mydb` is not taken as a secret.
