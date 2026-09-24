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
`SECRET_KEY_BASE` are left alone, and a negated flag such as `psql --no-password mydb`,
`mysql --skip-password mydb` or `tool --db-no-password mydb` is not taken as a secret. After a
prefixed name, a plain number or `true`/`false` stays visible when the word right before the
sensitive name is `total`, `has`, `max`, `min`, `count`, `is` or `enable`, so `total_token=5` and
`has_secret=false` read as written. Every other value stays hidden, including
`DB_PASSWORD=123456` and `limit_token=5`. One-dash flags such as `-db-password value`
and `-token value` are read as flags too. The terminal holds a prefixed name whole across reads,
with a `set "` or `$env:` before it, drops the rest of a value that outgrows what it carries up to
the value's end, and does not show a counting value whose line began before an idle flush. A
quoted value it drops ends only at an unescaped closing quote, even when a backslash and the quote
arrive in different reads. When a name alone outgrows what it carries, the value that follows is
still dropped whole, quoted or not, and the fields after it are kept. A quoted flag or `-D`
property value now honours backslash escapes, so `--token "a\"b"` is hidden whole instead of
leaving `b` in clear. A quoted value, including `$'...'`, now stays hidden up to its unescaped
closing quote across spaces, tabs, `;`, CR, LF and terminal reads, so `NPM_TOKEN="a b"` read in
two pieces and `--npm-token="a\rb"` no longer show `b`, in terminal output, stored command output,
approval cards and thread copies. A quote that never closes hides the rest of the record, and the
terminal and the command output stream keep hiding into the following output until it closes,
across an idle flush too.
