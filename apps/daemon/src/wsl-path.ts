import { assertDistributionName } from "./wsl-git.js"
import { runWslText, withWslDeadline, wslTimeoutMs, type WslRunner } from "./wsl-run.js"

export type DistributionPathInput = {
  distribution: string
  path: string
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

// The distribution places a path in its own filesystem with its own wslpath,
// so nothing here assumes where it mounts Windows drives. Asking it back which
// Windows path the answer is settles the boundary: a path inside the
// distribution reads back as its share, a Windows drive reads back as a drive.
export async function distributionPath(input: DistributionPathInput): Promise<string> {
  const distribution = assertDistributionName(input.distribution)
  const run = input.run ?? runWslText
  const timeoutMs = wslTimeoutMs(input.timeoutMs)
  const ask = (flag: "-u" | "-w", path: string) => withWslDeadline(
    run("wsl.exe", ["-d", distribution, "--", "wslpath", flag, path], { timeoutMs }),
    timeoutMs,
  )
  const requested = windowsForm(input.path)

  let placed: string
  try {
    placed = (await ask("-u", requested)).trim()
  } catch (error) {
    if (error instanceof Error && /in time/.test(error.message)) throw error
    throw new Error(`${distribution} could not place ${input.path} in its filesystem`, { cause: error })
  }
  if (!placed.startsWith("/")) {
    throw new Error(`${distribution} could not place ${input.path} in its filesystem`)
  }

  const readBack = (await ask("-w", placed)).trim()
  if (ownShare(distribution, readBack)) return placed
  if (/^[A-Za-z]:/.test(readBack)) {
    throw new Error(
      `${input.path} is on a Windows drive that ${distribution} mounts at ${placed}, not inside ${distribution}. Open ${readBack} from Windows instead.`,
    )
  }
  throw new Error(`${input.path} is not inside ${distribution}: ${distribution} reaches it as ${readBack}`)
}
