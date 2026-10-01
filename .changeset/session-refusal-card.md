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
pressed (a fork with a new request id). A refusal for a repository that is already trusted, which
the daemon still sends until trusted filters can run, says so and offers no trust. Any other
failure stays where it was shown before. Codex's own refusal of a worktree's .codex config has no
code and still shows as the daemon's sentence.

The trust sheet lists each filter driver the repository's own Git config sets, one group per git
config file and scope, with each operation and its redacted command, and says that a filter runs
whatever file its command names, an agent's edit included. A Git config the daemon could not
read, or filter entries it left out, block trust as an unreadable config file does. The Tools
tab's held back card lists the git config file with its count, so a repository whose only config
is a filter can be reviewed.
