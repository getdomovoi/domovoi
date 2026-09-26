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
across an idle flush too. A command substitution, `$(...)` or a backtick pair, now stays hidden up to
its matching closing delimiter, nested or inside double quotes, across spaces, line breaks and
terminal reads, so `TOKEN=$(get secret value)` and ``--token `get secret` `` no longer show what
follows the first space. A substitution that never closes is handled as an unclosed quote is.
Process substitutions, `<(...)` and `>(...)`, parameter expansions, `${...}`, arithmetic,
`$((...))`, and array assignments, `NAME=(...)`, now stay hidden up to their closers the same way,
so `NPM_TOKEN=<(printf a b)`, `NPM_TOKEN=${VAR:-a b}` and `NPM_TOKEN=(a b)` no longer show what
follows the first space. A value is now read as one shell word: a quote in the middle of it opens
(`TOKEN=ab"c d"`, `TOKEN=ab'c d'`, `TOKEN=ab$'c d'`), and a quoted value goes on to its delimiter
after its closing quote. A quote opened right before a name, as in `set "NAME=value"` or
`echo "NAME=a b"`, holds the value up to that quote's closer, honouring backslash escapes as any
quoted value does, so `set "TOKEN=a\"b"` no longer shows `b`, and the value goes on to its delimiter
after the closer, as `echo "TOKEN=a"b` is one word. Where the terminal has lost what came
before a name (an idle flush in the middle of it, or a name longer than it carries), a quote in the
value still opens, so a `set "NAME=value"` split there may hide the output that follows until
another quote arrives. A deeply nested value read one
character at a time now costs each read only what that read holds, rather than a copy of the whole
nesting. A `-D` property may have spaces after its `=`, so `java -DPassword= value` is hidden. A
name and separator inside a value, as in `-DGITHUB_TOKEN ==Password: value`, hide the value that
follows them too, even past the end of the value they sit in. A name and separator at the end of a
line, as in `X_TOKEN:` or `{"x-token":`, hide the first value on the next line in the command
output stream as they already did in stored output and the terminal, so that stream holds such a
line until the next one arrives. A name inside another name's quoted value, as in
`java -Dpassword="a API_KEY=b" -jar app.jar`, is part of that value: it is hidden with it, and what
follows the value is kept. A doubled separator or terminal formatting where a value starts, as in
`TOKEN==(a b)` or a colour code before the value, still lets an array's `(` open there. The
terminal no longer shows a value that ends in or holds a sensitive word when a read ends inside it,
as in `TOKEN=abctoken` followed by more, or a flag typed one character at a time: it holds from the
name that value belongs to. A sensitive word glued to the end of a value, with a separator after it
(`TOKEN=abctoken: value`), hides the value after it. At an idle beat the terminal keeps dropping a
word it was reading, a closed quote's word included, up to its delimiter, and a name and separator
at the end of what it shows drop the value typed after the beat. A name after the closing quote of
`set "NAME=value"` hides its own value in every copy. A long chain of glued names
(`API_KEY=a_token=a_token=…`) is read in linear time.
