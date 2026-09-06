# First alpha: maintainer setup

This checklist changes account settings and eventually publishes packages. It is for a
maintainer to execute deliberately, not a script to run as part of implementation or review.
Desktop installers, signing and notarization are a separate workstream.

## Confirmed blockers, 2026-09-06

Read-only checks against `getdomovoi/domovoi` and the public npm registry found:

| Boundary | Observation | Required action |
| --- | --- | --- |
| Repository variables | No variables, including `RELEASE_PUBLISHING` | Opt in only after setup |
| GitHub environments | No `npm` environment | Create and protect it before publishing |
| Actions policy | Default token permissions `read`; `can_approve_pull_request_reviews: false` | Enable PR creation, not repository-wide write defaults |
| npm packages | Both `@getdomovoi/protocol` and `@getdomovoi/daemon` return 404 | Bootstrap their first public versions |
| Prerelease state | All six manifests are `0.0.1`; no `.changeset/pre.json` | Review and enter alpha mode before versioning |
| Release protection | No main branch protection/ruleset or GitHub release | Retain the exact-commit CI gate and protect environment admission |

npm organization ownership and name availability were not established by those package 404s.
Do not treat missing packages as proof that the organization is available.

The read-only Actions default is not itself a blocker: the version job explicitly requests
`contents: write` and `pull-requests: write`. The separate PR-creation setting is the blocker.
The pinned Changesets action pushes through the GitHub API, so checkout credentials need not be
persisted and no personal access token is required for version PRs.

npm requires a package to exist before configuring its trusted publisher. Publishing a
placeholder from a laptop would not meet this project's hosted provenance requirement.
The workflow therefore includes a manual first-publish option, using a temporary token in the
same protected environment as subsequent OIDC releases. [npm trust prerequisites](https://docs.npmjs.com/cli/v12/commands/npm-trust/),
[hosted provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

## Execute in this order

1. **Merge the repository automation.** Changesets 3.0.1 produces `0.1.0-alpha.0` from the
   current minor changesets after `pre enter alpha`, and the roadmap names that same first
   alpha. This automation does not hand-edit versions or skip a prerelease number. Before 1.0,
   a breaking change uses a minor changeset; an additive compatible change uses patch. State
   upgrade actions in the note.
2. **Confirm npm ownership.** Sign in to npm, confirm ownership of the `getdomovoi` organization
   or create it if available, and enable two-factor authentication on the publishing account.
   Confirm that account can create public packages under `@getdomovoi`.
3. **Allow the version PR.** In GitHub repository Settings, Actions, General, Workflow
   permissions, enable **Allow GitHub Actions to create and approve pull requests**. Leave
   the default token permission read-only. If the checkbox is disabled, an organization owner
   must first permit that setting at the organization level.
4. **Protect publication.** In Settings, Environments, create **`npm`**. Restrict deployment
   branches to the selected branch **`main`**, not a protected-branches-only setting when no
   protected branch exists. Add required reviewers and disallow administrator bypass. If using
   Prevent self-review, another approved reviewer must be available for a maintainer dispatch.
5. **Enter prerelease mode in a reviewed PR.** Run `pnpm changeset pre enter alpha` and commit
   `.changeset/pre.json`. Merge after its checks pass. Do not run `pre exit` until a stable
   release is intended. No publish follows this step while the variable remains absent.
6. **Enable versioning only.** In Settings, Secrets and variables, Actions, Variables, create
   **`RELEASE_PUBLISHING=version-only`**. The next main push or a manual `release` run with
   **first_publish unchecked** can open the version PR after that commit's CI passes.
   Approve any pending CI runs on the bot-created PR, review all six versions and changelogs,
   then merge. Wait for the merge commit's full CI verdict. Publishing remains disabled.
   [GitHub's bot-triggered PR approval behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).
7. **Create the one-time credential.** On npm, Access Tokens, Generate New Token: use granular
   **Packages and scopes: Read and write**, limited to the **`@getdomovoi` scope**, with the
   shortest available expiration. Select **Bypass two-factor authentication** for this one
   unattended publish. Organization-management permission is not package publish permission
   and is not needed. Store the value as **`NPM_BOOTSTRAP_TOKEN` in the GitHub `npm` environment**,
   never a repository file, workflow input or pasted log. Revoke it after bootstrap.
   [npm token fields and their meanings](https://docs.npmjs.com/creating-and-viewing-access-tokens/).
8. **Authorize the first public publish.** Change the variable to
   **`RELEASE_PUBLISHING=enabled`**. In Actions, `release`, Run workflow, select **main** and
   explicitly check **first_publish**. Confirm the selected commit is the reviewed alpha,
   then approve the `npm` environment job. This step publishes protocol before daemon, both
   with provenance, and creates the canonical `v<version>` GitHub prerelease and its assets.
   Avoid unrelated main pushes during initial setup. A normal run has no bootstrap token and
   cannot substitute one if OIDC is not configured.
9. **Check the result before removing bootstrap access.** Verify both registry versions,
   their `alpha` dist-tags, and the provenance source commit/run. Verify the canonical tag
   names the same commit and the release has both tarballs, both SBOMs and `SHA256SUMS`.
   Test the bootstrap installer against that version. The first successful hosted run, not
   the local tests of this code, establishes that account admission and provenance work.
10. **Configure ordinary trusted publishing for each package.** On npm, each package's Settings,
    Trusted Publisher, add GitHub Actions with these exact fields:
    organization **`getdomovoi`**, repository **`domovoi`**, workflow **`release.yml`**, environment
    **`npm`**. Explicitly allow **direct `npm publish`**. New configurations default to staged
    publication, which this workflow does not use. Revoke the bootstrap token and delete the
    GitHub environment secret. Require two-factor authentication and disallow traditional
    tokens for package publishing; OIDC remains supported. Leave **first_publish unchecked**
    for every subsequent release. Saving a trusted publisher is not a live authentication
    test; verify the first normal publish independently. [npm trusted publisher settings](https://docs.npmjs.com/trusted-publishers/).

For future releases, contributors add changesets, automation opens a version PR, and a
maintainer reviews its CI, merges it, and approves the protected publish job. Keeping the
repository variable at `version-only` allows version PRs while withholding publication.
Removing it disables both. Changing it does not cancel an already-running publish job.

## Failure and retry rules

- Failed CI, missing CI, a skipped required CI job, or an unknown registry response refuses
  publication. Do not weaken the gate to get the first alpha out.
- Before npm publication, read-only preflight refuses known tag, release, asset and existing
  registry-byte conflicts. Final publication repeats the checks. Another writer can still
  interfere between services; the workflow does not claim cross-service atomicity.
- If protocol published and daemon did not, rerun the failed job from the **same workflow run**.
  It uses the same checked artifact, retained for 30 days. Bootstrap admission permits an
  already-published first version only when its integrity and provenance reference match.
- If npm succeeded but GitHub creation failed, rerun that failed publish job with its original
  artifact. The canonical release step runs even when Changesets publishes nothing new.
  A new workflow run may select `nothing`, so it is not a substitute for that retry.
- Never rebuild and overwrite a partially published version. A tag naming another commit or
  an asset with another checksum is refused. Inspect and release a new version if repair cannot
  preserve the original bytes. After artifact retention expires, recovery requires a deliberate
  maintainer review; there is no automatic repack-and-replace path.
- An incomplete GitHub release remains a draft. Publication follows successful checksum checks
  for every required asset. Asset inspection reads GitHub's reported SHA-256 digest. Registry
  inspection requires npm's provenance reference; it is not an independent Sigstore verifier.

## Evidence and limits

Local tests run the real Changesets CLI in a temporary Git repository, including prerelease
versioning and changelogs. They pin the current publish-plan format, channel selection,
artifact and source-commit binding, API ordering, refusals, and finite waits. The existing
release-artifact suite packs the actual daemon and protocol and checks their runtime inventories.
GitHub writes and registry admission in the new tests use injected ports. No release workflow,
OIDC exchange, token publish, Git tag or GitHub release was executed during implementation.

This completes repository mechanisms, not the first public alpha. Account setup, approvals,
the first hosted publish and its installed-artifact verification remain release prerequisites.
