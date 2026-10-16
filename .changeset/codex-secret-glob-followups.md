---
"@getdomovoi/daemon": patch
---

On macOS the Codex sandbox profile loads again under a long worktree path: one Seatbelt writes in
up to 768 bytes, where a dot, hyphen or other punctuation counts twice, in names of five bytes or
more. The secret name globs added in the previous release made the profile too large past about 580
bytes, and Seatbelt then refused every sandboxed command. The names now share a few grouped globs,
nine per list, and macOS spells them without letter classes, since Seatbelt compares paths without
letter case. A credential store's name followed by a letter outside ASCII (`.azureé`) is readable
again, as Domovoi's approval cards treat it, and a secret name followed by a comma or a control
character (`daemon.token,old`) is now refused. Still readable: a credential store's name followed by
a non-ASCII symbol (`.gnupg😀`), and on macOS a listed name followed by an accented letter the file
system stores decomposed.
