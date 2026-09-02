import { resolveOpenTarget, type OpenTarget } from "./wsl-open-target.js"

export type OpenCommandDependencies = {
  cwd: () => string
  distributions: () => Promise<readonly { name: string }[]>
  open: (target: OpenTarget) => Promise<void>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoi open [path]\n"

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
    target = resolveOpenTarget({ path, distributions: await dependencies.distributions() })
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  try {
    await dependencies.open(target)
  } catch {
    // The daemon's own error can name a path someone is watching the screen
    // for, so the failure is reported without repeating it.
    dependencies.stderr(`Could not open ${path}\n`)
    return 1
  }

  dependencies.stdout(
    target.kind === "wsl"
      ? `Opened ${target.path} in ${target.distribution}\n`
      : `Opened ${target.path}\n`,
  )
  return 0
}
