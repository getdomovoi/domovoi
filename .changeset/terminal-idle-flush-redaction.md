---
"@getdomovoi/daemon": patch
---

Terminal redaction no longer leaks a value typed after an idle beat released its name. The daemon
holds back a tail that might become a secret and releases it on a short idle beat so a prompt
shows; a value typed after the released name went out in clear, live and in the replay a
rejoining client is handed. The terminal redactor is still main's held-tail redactor. After an
idle release, the line as shown stays as context until it ends: a name and separator in it, even
one split around the beat, make what follows that name's value, and the value is shown as the
replacement. Durable redaction is unchanged.
