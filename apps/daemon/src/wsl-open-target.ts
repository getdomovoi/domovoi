import type { WslDistribution } from "./wsl-distributions.js"

export type OpenTarget =
  | { kind: "wsl"; distribution: string; path: string }
  | { kind: "windows"; path: string }

export type OpenTargetInput = {
  path: string
  distributions: () => Promise<readonly WslDistribution[]>
  translate: (distribution: string, windowsPath: string) => Promise<string>
}

export type WslSharePath = {
  distribution: string
  path: string
}

const wslHosts = new Set(["wsl$", "wsl.localhost"])

// Explorer and a shell write a distribution's files as \\wsl$\<name>\... or
// \\wsl.localhost\<name>\..., with either separator. This only reads the
// name and the rest of the path off the share; it never opens it.
export function wslSharePath(path: string): WslSharePath | undefined {
  const normalized = path.replace(/\\/g, "/")
  if (!normalized.startsWith("//")) return undefined

  const [host, distribution, ...rest] = normalized.slice(2).split("/").filter((segment) => segment !== "")
  if (host === undefined || distribution === undefined || !wslHosts.has(host.toLowerCase())) return undefined
  return { distribution, path: `/${rest.join("/")}` }
}

function shareInWindowsForm(distribution: string, sharePath: WslSharePath): string {
  const rest = sharePath.path.split("/").filter((segment) => segment !== "")
  return `\\\\wsl$\\${distribution}\\${rest.join("\\")}`
}

// A path under \\wsl$ is read here only to learn which distribution holds the
// work. The share itself is never opened: the distribution places the path in
// its own filesystem, and its own daemon does the filesystem and Git work.
export async function resolveOpenTarget(input: OpenTargetInput): Promise<OpenTarget> {
  if (input.path === "") throw new Error("there is no path to open")

  const normalized = input.path.replace(/\\/g, "/")
  if (!normalized.startsWith("//")) return { kind: "windows", path: input.path }

  const share = wslSharePath(input.path)
  if (!share) {
    const [host, distribution] = normalized.slice(2).split("/").filter((segment) => segment !== "")
    if (host !== undefined && wslHosts.has(host.toLowerCase()) && distribution === undefined) {
      throw new Error(`${input.path} names no distribution to open`)
    }
    throw new Error(`${input.path} is not a path on this machine`)
  }

  const known = (await input.distributions()).find(
    (candidate) => candidate.name.toLowerCase() === share.distribution.toLowerCase(),
  )
  if (!known) {
    throw new Error(
      `this machine has no WSL distribution called ${share.distribution}. "wsl.exe --list --verbose" names the ones it has.`,
    )
  }
  // A stopped distribution is left stopped: asking it anything would start it
  // on the strength of a path, and there is no daemon inside it to answer.
  if (known.state === "Stopped") {
    throw new Error(
      `${known.name} is stopped, so nothing inside it can answer. Start it with "wsl.exe -d ${known.name}", run domovoid inside it, and try again.`,
    )
  }
  if (known.version !== 2) {
    throw new Error(
      `${known.name} runs under WSL 1, which shares the Windows network stack with this machine's daemon, so Domovoi opens work only in WSL 2 distributions. Convert it with "wsl.exe --set-version ${known.name} 2" and run domovoid inside it.`,
    )
  }

  return {
    kind: "wsl",
    distribution: known.name,
    path: await input.translate(known.name, shareInWindowsForm(known.name, share)),
  }
}
