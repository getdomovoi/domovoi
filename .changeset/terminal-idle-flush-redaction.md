---
"@getdomovoi/daemon": patch
---

Terminal redaction no longer leaks a value split across reads or idle beats. The daemon held back
a tail that might become a secret and released it on a short idle beat so a prompt showed; a value
typed after the released part went out in clear, live and in the replay a rejoining client is
handed.

Every redactor now runs in two stages. The first adds the forms the previous code missed: a value
read in the context of its whole terminal line, shell quoting in flag and Java property values, a
backslash escaping any character short of a line end (including U+2028 and U+2029), and a quoted
value that holds a name and value of its own. The second is the previous redaction code itself,
kept byte for byte in its own module that a test pins to its source commit, and it reads last. A
differential fuzz test holds the result to hiding at least what the previous code hid and keeping
what it kept.
