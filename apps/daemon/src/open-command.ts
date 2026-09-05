import type { WslDistribution } from "./wsl-distributions.js"
import { resolveOpenTarget, type OpenTarget } from "./wsl-open-target.js"

export type OpenCommandDependencies = {
  cwd: () => string
  distributions: () => Promise<readonly WslDistribution[]>
  translate: (distribution: string, windowsPath: string) => Promise<string>
  open: (target: OpenTarget) => Promise<void>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoid open [path]\n"

// A refusal that names the distribution and what to do about it is worth
// repeating; anything else from the daemon can quote a path someone is
// watching the screen for, so only the fact of the failure is reported.
function isNamedRefusal(error: unknown): error is Error {
  return error instanceof Error && /domovoid|wsl\.exe/.test(error.message)
}

export async function runOpenCommand(
  args: readonly string[],
  dependencies: OpenCommandDependencies,
): Promise<number> {
  if (args[0] !== "open") return 1
  if (args.length > 2) {
    dependencies.stderr(usage)
    return 1
  }

  const requested = args[1]
  const path = requested === undefined || requested === "." ? dependencies.cwd() : requested

  let target: OpenTarget
  try {
    target = await resolveOpenTarget({
      path,
      distributions: dependencies.distributions,
      translate: dependencies.translate,
    })
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  try {
    await dependencies.open(target)
  } catch (error) {
    dependencies.stderr(isNamedRefusal(error) ? `${error.message}\n` : `Could not open ${path}\n`)
    return 1
  }

  dependencies.stdout(
    target.kind === "wsl"
      ? `Opened ${target.path} in ${target.distribution}\n`
      : `Opened ${target.path}\n`,
  )
  return 0
}
