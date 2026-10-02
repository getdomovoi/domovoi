---
"@getdomovoi/ui": patch
---

A new session the daemon refused because checking the repository out would run a git filter its
own Git config sets now shows as a refusal card in the thread, on desktop and web. The card reads
the refusal's code and data: Domovoi refused, the reason code, the filter drivers it names with
their git config scope, a count of drivers it did not name, and that nothing from the repository
ran. Review and trust opens the same trust sheet as the Tools tab, over the files as they are
now, where this client can grant trust; elsewhere the card says trust is granted from desktop or
web only. After a grant for the refused repository the card says it is trusted on the machine and
that nothing has started, and Start the session again repeats the refused request only when
pressed (a fork with a new request id). A refusal for a repository that is already trusted holds
its Git filters back under the grant read now, for a reason the refusal does not give: the card
says the filters are held back until they are reviewed again, and offers Review and trust again. Any other failure
stays where it was shown before. Codex's own refusal of a worktree's .codex config has no code and
still shows as the daemon's sentence. A start keeps the machine, project and session it was made
in: a refusal that arrives after the shell moved to another one is dropped, even when the shell
came back to the same one before it arrived, the card names the
repository and machine of the refused start, its review refuses an inventory read for another
project or machine, and Start the session again is made only in that scope.

The trust sheet lists each filter driver the repository's own Git config sets, one group per git
config file and scope, with each operation and its redacted command and its required state, and
says that a filter runs whatever file its command names, an agent's edit included. A Git config
the daemon could not read, or filter entries it left out, block trust as an unreadable config
file does. The Tools tab's held back card lists the git config file with its count, so a
repository whose only config is a filter can be reviewed. The sheet's pinned line counts only the
provider files, which are pinned by content, and a second line says that in the Git config only
the filter settings listed are pinned, not the whole file.

Trusting from the sheet now acknowledges the Git filters it showed: `repository.trust` carries
`gitFilters: { reviewed: true, reviewDigest }` with the review digest of the block the sheet drew,
so the daemon runs those filters. It is sent only when the block lists at least one filter and is
complete, which is also the only time trust is offered. When a read made while the sheet is open
shows other files or filters, the sheet says the files changed and trust sends the new digests
only on the next click. When the daemon refuses the acknowledgement, the sheet reads the files
again.
