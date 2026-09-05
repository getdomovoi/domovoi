import { readFileSync } from "node:fs"

import { machineWslFactsSchema, type MachineWslFacts } from "@getdomovoi/protocol"

export type WslHostInput = {
  platform?: NodeJS.Platform
  environment?: Readonly<Record<string, string | undefined>>
  readOsRelease?: () => string
}

const osReleasePath = "/proc/sys/kernel/osrelease"

function readKernelRelease(): string {
  return readFileSync(osReleasePath, "utf8")
}

// WSL 2 runs a Microsoft kernel whose release string names it; WSL 1 has no
// kernel of its own and reports a Microsoft build string instead. The interop
// socket is offered only under WSL 2, so it settles the version when the
// kernel string cannot be read.
function wslVersion(environment: Readonly<Record<string, string | undefined>>, readOsRelease: () => string): 1 | 2 {
  if (environment["WSL_INTEROP"]) return 2
  let release: string
  try {
    release = readOsRelease()
  } catch {
    return 1
  }
  return /wsl2/i.test(release) ? 2 : 1
}

// A daemon learns it is inside a distribution from the name WSL's init hands
// every process it starts. Nothing else names the distribution as wsl.exe
// registered it, so without that name no fact is reported rather than a guess:
// a supervisor that scrubs the environment leaves the daemon plain Linux.
export function wslHostFacts(input: WslHostInput = {}): MachineWslFacts | undefined {
  const platform = input.platform ?? process.platform
  if (platform !== "linux") return undefined

  const environment = input.environment ?? process.env
  const distribution = environment["WSL_DISTRO_NAME"]?.trim() ?? ""
  if (distribution === "") return undefined

  const facts = machineWslFactsSchema.safeParse({
    distribution,
    version: wslVersion(environment, input.readOsRelease ?? readKernelRelease),
  })
  return facts.success ? facts.data : undefined
}
