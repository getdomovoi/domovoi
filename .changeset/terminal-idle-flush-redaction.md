---
"@getdomovoi/daemon": patch
---

Terminal redaction no longer leaks a value split across reads or idle beats. The daemon held back
a tail that might become a secret and released it on a short idle beat so a prompt showed; a value
typed after the released part went out in clear, live and in the replay a rejoining client is
handed. Terminal output now passes through two stages. The first redacts each read in the context
of its whole current line, so a value is caught however its name, separator, whitespace and
quotes were split. The second is the previous held-tail redactor, unchanged, so everything it hid
stays hidden. A differential fuzz test holds the pair to hiding at least what the previous
redactor hid. Flag and Java property values in quotes now honour escaped quotes, in every
redaction.
