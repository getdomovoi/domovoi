import { insideDistribution } from "./wsl-path.js"
import { assertDistributionName, type WslRunner } from "./wsl-run.js"

export type DistroGitInput = {
  distribution: string
  repositoryPath: string
  args: readonly string[]
  run?: WslRunner<string>
  timeoutMs?: number
}

export type DistroCommand = {
  command: string
  args: string[]
}

function normalizePosix(path: string): string {
  const segments: string[] = []
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return `/${segments.join("/")}`
}

// The repository has to be named the way the distribution names it. A share
// path, a drive path, or a relative path all mean the work would be reached
// from Windows instead of inside the distribution. The path is normalized
// first, since /home/me/../../mnt/c is the same place written a longer way.
// Whether it is a Windows drive the distribution mounts is not decided here:
// only the distribution knows where it mounts them, so it is asked.
function distributionPathShape(repositoryPath: string): string {
  if (!repositoryPath.startsWith("/") || repositoryPath.startsWith("//")) {
    throw new Error(`${repositoryPath} is not a path inside the distribution`)
  }

  const normalized = normalizePosix(repositoryPath)
  if (normalized === "/") {
    throw new Error(`${repositoryPath} is not a path inside the distribution`)
  }
  return normalized
}

// These options tell git to work somewhere other than the directory it was
// started in, which would put the work outside the repository that was asked
// for. A subcommand's own options are left alone.
const repositorySelecting = ["-C", "--git-dir", "--work-tree", "--exec-path", "--namespace"]

function assertNoRepositorySelection(args: readonly string[]): readonly string[] {
  for (const argument of args) {
    const name = argument.split("=")[0] ?? argument
    if (repositorySelecting.includes(name)) {
      throw new Error(`${name} would choose a repository other than the one asked for`)
    }
    if (argument === "--") break
  }
  return args
}

// Git runs in the distribution, in its own filesystem, never across the wsl
// share and never on a Windows drive the distribution mounts. The distribution
// is asked where the repository reads back before git is asked to run there,
// with the rule the open shim applies, so a path the shim hands over is one
// the runner accepts. Arguments are passed as a list, so nothing is re-parsed
// by a shell, and `--` closes wsl.exe's own options before the command begins.
export async function distroGitCommand(input: DistroGitInput): Promise<DistroCommand> {
  if (input.args.length === 0) throw new Error("there is no git command to run")

  const distribution = assertDistributionName(input.distribution)
  const shaped = distributionPathShape(input.repositoryPath)
  const args = assertNoRepositorySelection(input.args)
  const repository = await insideDistribution({
    distribution,
    path: shaped,
    ...(input.run ? { run: input.run } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
  })

  return {
    command: "wsl.exe",
    args: ["-d", distribution, "--cd", repository, "--", "git", ...args],
  }
}
