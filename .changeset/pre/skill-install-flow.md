---
"@getdomovoi/protocol": minor
"@getdomovoi/daemon": minor
"@getdomovoi/ui": minor
---

Add a skill from a folder on the execution machine after a review. `skill.installPreview` returns
the parsed manifest, the declared capabilities, the content and source digests, the signature and
trust state, the file list, and the install targets per scope. `skill.install` copies the folder
into the `user` or `project` Domovoi skill root only when its digest still matches the preview,
refuses a blocked skill, a link that leaves the folder, and an existing name with different files,
stages the copy inside the root and renames it into place, and audits the result. The Skills
surface gains an Add skill review step with the scope choice, and `domovoid skill add` prints the
same review and installs with `--yes`.
