# Security policy

Domovoi can execute commands, access repositories, render agent-generated documents, and connect
to remote machines. Treat suspected security defects as private until a fix is available.

## Supported versions

Domovoi has not published a stable release. Until the first release, security fixes target the
current `main` branch only. After releases begin, this table will identify supported release lines.

| Version | Supported |
| --- | --- |
| `main` | Yes |
| Older commits and unlisted builds | No |

## Reporting a vulnerability

Use GitHub's private [Report a vulnerability][report] form. Do not open a public issue, discussion,
or pull request for an undisclosed vulnerability.

Include, when possible:

- the affected commit or version and operating system;
- the affected surface, such as daemon RPC, terminal, preview sandbox, desktop shell, or web app;
- reproduction steps or a minimal proof of concept;
- the security impact and required attacker access;
- whether secrets, repositories, remote machines, or user data may be exposed; and
- any suggested mitigation.

Remove live API keys, access tokens, credentials, private repository content, and personal data
from the report. If evidence cannot be safely redacted, describe it first and wait for a secure
transfer method.

The maintainers target an acknowledgment within three business days, an initial assessment within
seven business days, and a status update at least every fourteen days until resolution. These are
response targets, not service-level guarantees.

## Security scope

Examples include:

- authentication or authorization bypasses;
- unintended remote daemon exposure;
- command or terminal execution outside the selected machine, project, or permission mode;
- preview sandbox escapes or unsafe navigation;
- path traversal or access outside an authorized worktree;
- leakage of provider keys, daemon tokens, repository content, or terminal output;
- forged or reusable artifact capabilities; and
- exploitable dependency or release-pipeline compromise.

Crashes, ordinary bugs, and hardening suggestions without a demonstrated security impact can use a
normal issue.

## Disclosure

Please allow time to investigate and release a fix before public disclosure. When appropriate, the
maintainers will coordinate a GitHub Security Advisory, affected-version notice, credit, and CVE.
Good-faith research that avoids privacy violations, service disruption, data destruction, and
access beyond what is necessary to demonstrate the issue is welcome.

[report]: https://github.com/getdomovoi/domovoi/security/advisories/new
