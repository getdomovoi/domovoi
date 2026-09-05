import { assertDistributionName, runWslText, withWslDeadline, WslError, wslTimeoutMs, type WslRunner } from "./wsl-run.js"

export type DistributionPathInput = {
  distribution: string
  path: string
  run?: WslRunner<string>
  timeoutMs?: number
}

export type InsideDistributionInput = {
  distribution: string
  path: string
  requested?: string
  run?: WslRunner<string>
  timeoutMs?: number
}

// wslpath reads a Windows path with backslashes. A share written with forward
// slashes, as a shell or a URL might, is the same place spelled differently.
function windowsForm(path: string): string {
  const spelled = path.replace(/\//g, "\\")
  // \\wsl$\name names the distribution root, which wslpath places only as a
  // directory, so the root is asked for with its trailing separator.
  return /^\\\\[^\\]+\\[^\\]+$/.test(spelled) ? `${spelled}\\` : spelled
}

function ownShare(distribution: string, windowsPath: string): boolean {
  const match = /^\\\\(wsl\$|wsl\.localhost)\\([^\\]+)(?:\\|$)/i.exec(windowsPath.replace(/\//g, "\\"))
  return match?.[2]?.toLowerCase() === distribution.toLowerCase()
}

function wslpath(distribution: string, run: WslRunner<string>, timeoutMs: number) {
  return (flag: "-u" | "-w", path: string) => withWslDeadline(
    run("wsl.exe", ["-d", distribution, "--", "wslpath", flag, path], { timeoutMs }),
    timeoutMs,
  )
}

// The distribution says which Windows path a path of its own is, which settles
// the boundary without assuming where it mounts Windows drives: a path in its
// filesystem reads back as its share, a Windows drive reads back as a drive
// wherever the distribution put it, and anything else is somewhere it merely
// reaches. This is the one rule the open shim and the git runner apply.
export async function insideDistribution(input: InsideDistributionInput): Promise<string> {
  const distribution = assertDistributionName(input.distribution)
  const ask = wslpath(distribution, input.run ?? runWslText, wslTimeoutMs(input.timeoutMs))
  const requested = input.requested ?? input.path

  let readBack: string
  try {
    readBack = (await ask("-w", input.path)).trim()
  } catch (error) {
    if (error instanceof WslError) throw error
    throw new Error(`${distribution} could not say which Windows path ${input.path} is`, { cause: error })
  }
  if (ownShare(distribution, readBack)) return input.path
  if (/^[A-Za-z]:/.test(readBack)) {
    throw new Error(
      `${requested} is on a Windows drive that ${distribution} mounts at ${input.path}, not inside ${distribution}. Open ${readBack} from Windows instead.`,
    )
  }
  throw new Error(`${requested} is not inside ${distribution}: ${distribution} reaches it as ${readBack}`)
}

// The distribution places a path in its own filesystem with its own wslpath,
// and is then asked back which Windows path the answer is.
export async function distributionPath(input: DistributionPathInput): Promise<string> {
  const distribution = assertDistributionName(input.distribution)
  const run = input.run ?? runWslText
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  const ask = wslpath(distribution, run, timeoutMs)
  const requested = windowsForm(input.path)

  let placed: string
  try {
    placed = (await ask("-u", requested)).trim()
  } catch (error) {
    if (error instanceof WslError) throw error
    throw new Error(`${distribution} could not place ${input.path} in its filesystem`, { cause: error })
  }
  if (!placed.startsWith("/")) {
    throw new Error(`${distribution} could not place ${input.path} in its filesystem`)
  }

  return insideDistribution({ distribution, path: placed, requested: input.path, run, timeoutMs })
}
