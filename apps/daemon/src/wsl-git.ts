export type DistroGitInput = {
  distribution: string
  repositoryPath: string
  args: readonly string[]
}

export type DistroCommand = {
  command: string
  args: string[]
}

const unsafeCharacters = new Set(["\"", "\\", "/"])

// A control character or a separator in the name would either be swallowed by
// wsl.exe or would name a different distribution than the one asked for.
function hasUnsafeCharacter(value: string): boolean {
  for (const character of value) {
    if (unsafeCharacters.has(character)) return true
    if ((character.codePointAt(0) ?? 0) < 0x20) return true
  }
  return false
}

// A path under /mnt is a Windows drive the distribution has mounted, so git
// there would be reaching back across the boundary this whole module exists to
// hold. The path is normalized first, since /home/me/../../mnt/c is the same
// place written a longer way.
const windowsMountRoot = "/mnt"

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

// A path may be spelled with . and .. and still name a Windows drive, so it is
// normalized before that is decided. This is the one rule both the router and
// the git runner apply, so a path the router hands over is one the runner
// would accept.
export function distributionPathOffWindowsDrives(path: string): string {
  const normalized = normalizePosix(path)
  if (normalized === windowsMountRoot || normalized.startsWith(`${windowsMountRoot}/`)) {
    throw new Error(`${path} is a Windows drive, not a path inside the distribution`)
  }
  return normalized
}

// The repository has to be named the way the distribution names it. A share
// path, a drive path, or a relative path all mean the work would be reached
// from Windows instead of inside the distribution.
function assertInsideDistribution(repositoryPath: string): string {
  if (!repositoryPath.startsWith("/") || repositoryPath.startsWith("//")) {
    throw new Error(`${repositoryPath} is not a path inside the distribution`)
  }

  const normalized = distributionPathOffWindowsDrives(repositoryPath)
  if (normalized === "/") {
    throw new Error(`${repositoryPath} is not a path inside the distribution`)
  }
  return normalized
}

export function assertDistributionName(distribution: string): string {
  if (distribution === "" || hasUnsafeCharacter(distribution) || distribution.startsWith("-")) {
    throw new Error(`${JSON.stringify(distribution)} is not a distribution wsl.exe can be asked for`)
  }
  return distribution
}

// Git runs in the distribution, in its own filesystem, never across the wsl
// share. Arguments are passed as a list, so nothing is re-parsed by a shell,
// and `--` closes wsl.exe's own options before the command begins.
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

export function distroGitCommand(input: DistroGitInput): DistroCommand {
  if (input.args.length === 0) throw new Error("there is no git command to run")

  return {
    command: "wsl.exe",
    args: [
      "-d",
      assertDistributionName(input.distribution),
      "--cd",
      assertInsideDistribution(input.repositoryPath),
      "--",
      "git",
      ...assertNoRepositorySelection(input.args),
    ],
  }
}
