export type OpenTarget =
  | { kind: "wsl"; distribution: string; path: string }
  | { kind: "windows"; path: string }

export type OpenTargetInput = {
  path: string
  distributions: readonly { name: string }[]
}

const wslHosts = new Set(["wsl$", "wsl.localhost"])

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

  return { kind: "wsl", distribution: known.name, path: `/${rest.join("/")}` }
}
