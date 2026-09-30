import { execFile } from "node:child_process"
import { mkdtemp, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { repositoryGitFilterErrorCode } from "@getdomovoi/protocol"
import { afterEach, describe, expect, it } from "vitest"

import { repositoryGitFilterRpcError } from "./repository-git-filter-refusal.js"
import type { RepositoryGitFilter } from "./repository-git-filters.js"
import { readRepositoryProviderConfig } from "./repository-provider-config.js"
import { projectRootRead } from "./repository-trust-apply.js"
import type { RepositoryTrustGrant } from "./repository-trust-store.js"
import { removeScratchDirectories } from "./test-scratch.js"
import { RepositoryGitFilterRefusedError } from "./workspace.js"

const execute = promisify(execFile)
const scratchDirectories: string[] = []
afterEach(async () => removeScratchDirectories(scratchDirectories.splice(0)))

describe("repositoryGitFilterRpcError", () => {
  // The refused configuration can differ from the project root's: a filter an
  // includeIf "onbranch:domovoi/**" include adds only for the session branch,
  // or one a fork's source worktree sets. The data's digest and trust are the
  // root's configuration with the filters the refused checkout would run, so
  // a grant for the root as it reads never shows as covering them.
  it("binds the digest and trust to the filters the refused checkout would have run", async () => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), "domovoi-git-filter-refusal-")))
    scratchDirectories.push(scratch)
    await writeFile(join(scratch, "empty.gitconfig"), "")
    const root = join(scratch, "project")
    await execute("git", ["init", "--initial-branch=main", root], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: join(scratch, "empty.gitconfig"), GIT_CONFIG_SYSTEM: join(scratch, "empty.gitconfig") },
    })
    const rootDigest = (await readRepositoryProviderConfig(root, projectRootRead)).configDigest
    const grant: RepositoryTrustGrant = {
      projectId: "project-acme", trustedDigest: rootDigest, trustedAt: "2026-09-30T12:00:00.000Z", trustedBy: { client: "desktop" },
    }
    const refused: RepositoryGitFilter = {
      scope: "local", key: "filter.agent.smudge", driver: "agent", operation: "smudge", value: "sh ./payload.sh", origin: join(scratch, "agent.gitconfig"),
    }

    const error = await repositoryGitFilterRpcError({
      error: new RepositoryGitFilterRefusedError([refused], { worktreeRemoved: true, branchRemoved: true }),
      project: { id: "project-acme", path: root },
      grant,
    })

    expect(error?.code).toBe(repositoryGitFilterErrorCode)
    expect(error?.data.configDigest).not.toBe(rootDigest)
    expect(error?.data.trust).toMatchObject({ state: "untrusted", reason: "config-changed", trustedDigest: rootDigest })
    expect(error?.data.drivers).toEqual([{ name: "agent", scope: "local" }])
  })
})
