import { distributionPathOffWindowsDrives } from "./wsl-git.js"

export type OpenTarget =
  | { kind: "wsl"; distribution: string; path: string }
  | { kind: "windows"; path: string }

export type OpenTargetInput = {
  path: string
  distributions: readonly { name: string }[]
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

// A path under \\wsl$ is read here only to learn which distribution holds the
// work. The share itself is never opened: the answer is a Linux path for that
// distribution's own daemon, so filesystem and Git work stays inside it.
export function resolveOpenTarget(input: OpenTargetInput): OpenTarget {
  if (input.path === "") throw new Error("there is no path to open")

  const normalized = input.path.replace(/\\/g, "/")
  if (!normalized.startsWith("//")) return { kind: "windows", path: input.path }

  const [host, distribution, ...rest] = normalized.slice(2).split("/").filter((segment) => segment !== "")
  if (host === undefined || !wslHosts.has(host.toLowerCase())) {
    throw new Error(`${input.path} is not a path on this machine`)
  }
  if (distribution === undefined) throw new Error(`${input.path} names no distribution to open`)

  const known = input.distributions.find(
    (candidate) => candidate.name.toLowerCase() === distribution.toLowerCase(),
  )
  if (!known) throw new Error(`this machine has no WSL distribution called ${distribution}`)

  // The share can name a Windows drive the distribution has mounted, which is
  // the boundary this exists to hold, reached from the other side.
  return {
    kind: "wsl",
    distribution: known.name,
    path: distributionPathOffWindowsDrives(`/${rest.join("/")}`),
  }
}
