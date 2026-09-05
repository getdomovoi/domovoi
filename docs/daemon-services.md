# Daemon service configuration

`domovoid service install` installs a per-user systemd unit, launchd agent, or Windows logon task.
It captures the current daemon configuration before asking the service manager to start anything.
Close other daemon owners, including Desktop, before starting the service. Desktop attachment to an
already supervised daemon remains separate work.
Existing installations need one reinstall to replace their old launch command; upgrading the binary
alone does not rewrite service-manager configuration.

The installer writes `<user-home>/.domovoi/service.json`. The installed command names the Node
runtime, daemon entry point, and `--service-config <path>` explicitly. On startup the production
factory receives the saved settings, not daemon variables inherited from the supervisor.
Windows installation refuses command lines over 262 characters before writing files; use shorter
absolute installation paths rather than a truncated launch command.

The versioned file contains listener host and port, remote-listener opt-in, TLS certificate and key
**paths**, advertised host, allowed browser origins, credential and machine-identity paths, and the
user home used for durable state. Relative input paths become absolute against the installing
shell's working directory. The default paths and port are captured too, so a changed environment
cannot silently choose a different identity or endpoint after a restart.

No bearer, TLS key contents, provider credentials, or arbitrary shell environment are serialized.
An install with `DOMOVOI_AUTH_TOKEN` set refuses before writing files or invoking the manager.
Use an existing private credential file via `DOMOVOI_CREDENTIAL_PATH`, unset the environment bearer,
then install again. If no file exists, the daemon creates its normal file credential when it starts.
The installer does not copy, rotate, or mint credentials. Changing to a different credential is an
operator decision, not an automatic migration.

Service files and their immediate parent directories are set to modes `0600` and `0700` on Unix,
including pre-existing entries. Windows uses the user directory's inherited ACLs. These files hold
settings and secret paths, not secret contents.

Saved configurations are limited to 64 KiB, reject unknown fields, and must satisfy the same
listener and origin validation as an interactive daemon. A missing, malformed, incompatible, or
unreadable file refuses startup and names the file. There is no fallback to default settings.
Loading has a five-second deadline. Service install, status, and removal each share one 30-second
deadline across filesystem and manager steps; an expired step cannot initiate a later step.

To change settings, stop the service, run installation again with the intended environment, then
restart it. Installation does not guarantee that a manager reloads an already running process.
Removal deletes the saved configuration after the manager commands succeed. It does not remove the
credential, identity, workspace database, or worktrees.

## Evidence and remaining limits

Tests round trip one non-default configuration through all three service formats. A distributed-CLI
test intercepts only OS-manager subprocess calls, checks the real files and launch command, then
launches the real daemon with a conflicting environment and authenticates over its saved TLS
endpoint. Removing the CLI environment handoff makes that test recover the default endpoint and
identity paths instead.
The TLS fixture requires `openssl` on the test runner's PATH to generate its temporary certificate.

This proves configuration delivery, not native systemd, launchd, or Task Scheduler lifecycle
behavior. Real manager restart/removal checks, installer rollback, and Desktop/service ownership
remain separate audit work. A timed-out manager may already have changed OS state; inspect service
status before retrying. Each file is replaced by a same-directory rename only after a complete
private staging write. A failed write preserves the last complete file. Expiry or a crash can leave
a private `.tmp` sibling; it is never read as configuration and may be removed after installation
has stopped. Replacement of the configuration and unit is not one cross-file transaction.

Launch escaping follows the managers' own rules, not a shell: systemd expands specifiers and
environment references in command lines, while Task Scheduler accepts the program and arguments
through `/tr`. See [systemd.service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)
and [schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create).
