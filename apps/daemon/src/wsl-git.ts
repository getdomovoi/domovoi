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

// The repository has to be named the way the distribution names it. A share
// path, a drive path, or a relative path all mean the work would be reached
// from Windows instead of inside the distribution.
function assertInsideDistribution(repositoryPath: string): string {
  if (!repositoryPath.startsWith("/") || repositoryPath.startsWith("//")) {
    throw new Error(`${repositoryPath} is not a path inside the distribution`)
  }
  return repositoryPath
}

function assertDistribution(distribution: string): string {
  if (distribution === "" || hasUnsafeCharacter(distribution) || distribution.startsWith("-")) {
    throw new Error(`${JSON.stringify(distribution)} is not a distribution wsl.exe can be asked for`)
  }
  return distribution
}

// Git runs in the distribution, in its own filesystem, never across the wsl
// share. Arguments are passed as a list, so nothing is re-parsed by a shell,
// and `--` closes wsl.exe's own options before the command begins.
export function distroGitCommand(input: DistroGitInput): DistroCommand {
  if (input.args.length === 0) throw new Error("there is no git command to run")

  return {
    command: "wsl.exe",
    args: [
      "-d",
      assertDistribution(input.distribution),
      "--cd",
      assertInsideDistribution(input.repositoryPath),
      "--",
      "git",
      ...input.args,
    ],
  }
}
