import { fileURLToPath } from "node:url"

// Ruling Q3 B: `domovoi daemon install|status|remove` runs the daemon
// package's own command (runDaemonCommand in @getdomovoi/daemon), so one code
// path installs the service and registers the daemon's worker entry, never
// this CLI's. Importing it starts nothing.
export type DaemonCommandModule = { runDaemonCommand: (args: readonly string[]) => Promise<number> }

export type DaemonCommandLoaders = {
  fromPackage: () => Promise<DaemonCommandModule>
  fromPath: (url: URL) => Promise<DaemonCommandModule>
}

// Q31 A: the desktop runtime ships this CLI as <runtime>/cli without a second
// copy of the daemon, beside <runtime>/daemon. When the package is absent,
// this one fixed path is tried; nothing is searched. Node gives an entry
// module its real path, so a link to the CLI's launcher does not move it.
export const siblingDaemonCommand = new URL("../../daemon/dist/daemon-command.js", import.meta.url)

export class DaemonCommandUnavailableError extends Error {}

const nodeLoaders: DaemonCommandLoaders = {
  fromPackage: () => import("@getdomovoi/daemon/daemon-command"),
  fromPath: (url) => import(url.href) as Promise<DaemonCommandModule>,
}

function notFound(error: unknown, quoted: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND" && error.message.includes(quoted)
}

export async function loadDaemonCommand(loaders: DaemonCommandLoaders = nodeLoaders): Promise<DaemonCommandModule> {
  try {
    return await loaders.fromPackage()
  } catch (error) {
    // Only the package itself being absent. A package that is there and
    // fails to load is reported as it failed.
    if (!notFound(error, "Cannot find package '@getdomovoi/daemon' ")) throw error
  }
  try {
    return await loaders.fromPath(siblingDaemonCommand)
  } catch (error) {
    // Only the sibling file itself; a part of it missing is its own failure.
    if (!notFound(error, `Cannot find module '${fileURLToPath(siblingDaemonCommand)}' `)) throw error
    throw new DaemonCommandUnavailableError("This domovoi has no @getdomovoi/daemon package, which runs domovoi daemon. Reinstall @getdomovoi/cli, which installs it.")
  }
}
