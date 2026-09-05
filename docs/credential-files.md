# Credential initialization and offline recovery

`daemon.token` holds the daemon's root bearer when `DOMOVOI_AUTH_TOKEN` is unset. Its default
path is `~/.domovoi/daemon.token`; `DOMOVOI_CREDENTIAL_PATH` can override it. The separate
`~/.domovoi/local-owner.key` authenticates local owner discovery. Neither file is a machine id
or a paired-device record. Anyone who can read the root bearer has ordinary client authority,
including sending work, approving commands and opening terminals. Never include either file's
bytes in logs, issue reports or command-line arguments.

## First creation

Both files use the same publication path:

1. Create a unique `<credential-path>.<uuid>.partial` file with exclusive creation and mode `0600`.
2. Write a fresh 32-byte random secret, sync the file and close it.
3. Hard-link that complete inode to the authoritative filename without replacing any existing
   file. If another initializer won, read and use its published credential.
4. Remove only this initializer's private staging name.

The containing directory uses mode `0700` on POSIX. On Windows, use a profile directory whose
inherited access controls restrict these files to the intended user. Hard-link support is
required, normally available on NTFS and local POSIX filesystems. There is no copying fallback:
an interrupted copy could expose an empty or partial authoritative file again. A publication
failure names the final path and leaves any existing credential unchanged.

A process killed before publication can leave private staging, but not an authoritative empty
file. A process killed after publication can leave both names for the same complete credential.
Restart reads only the authoritative name. It neither adopts old staging nor deletes it by age.
This is a process-interruption guarantee, not a guarantee against filesystem corruption or power
loss: the file is synced, but directory-entry durability depends on the filesystem.

The standalone initializer has a 30-second total deadline. Production startup supplies its
remaining factory deadline, so creating the bearer and owner key does not renew that budget.
After a late write, sync or close, the initializer cannot start publication. A filesystem call
already in progress may still finish after the caller times out. The timeout names the final and
staging paths and says if publication was already attempted. Check for a valid published file
before retrying; a timeout does not authorize replacing it. Cleanup may continue removing this
initializer's staging name. If cleanup fails after publication, the error says publication
completed and instructs reuse, not rotation.

## Existing empty or malformed files

An existing valid credential is reused. Empty files get a short bounded poll to accommodate an
older initializer still writing the final name. An empty file that stays empty, or a nonempty
malformed file, causes startup to refuse with its exact path. Neither is silently replaced.

For a file left incomplete by an older build, recovery is deliberately offline:

1. Stop Desktop, interactive daemons and every supervisor that can start a daemon using that
   exact credential path. Custom paths can be shared by multiple profiles. Do not move a file
   while any process may still be writing it.
2. Confirm that the refusal names the intended file and that it really is damaged. Do not
   replace a valid file to bypass a different authentication or ownership failure.
3. Create a quarantine directory accessible only to this user, mode `0700` on POSIX or an
   equivalent Windows ACL. Move the exact file named by the refusal into it. Retain those bytes
   for diagnosis and do not paste them into a support conversation.
4. Restart the intended owner. The absent final name permits a new credential to be created.
   A new root bearer invalidates clients configured with the old root bearer; reconnect them
   using the new credential. A new owner key changes local discovery authentication. Neither
   operation changes machine identity or revokes existing paired-device credentials.

The same stopped-process requirement applies before removing leftover private staging. Never
automatically age out or glob-delete credential candidates while an initializer might be live.
Quarantining credentials is not proof that a supervisor stopped and does not release profile
ownership. A stranded owner record still needs the separate
[local owner recovery procedure](local-daemon-ownership.md#service-installation-and-recovery).
