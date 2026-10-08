import { readFileSync } from "node:fs"
import { homedir, userInfo } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"

import type { ServiceCommandDependencies, ServiceCommandWords } from "./service/install.js"

// Both entry points, and any shared tsup chunks, live directly in dist/.
// The invoking binary may be the human CLI rather than the daemon worker.
export function daemonWorkerEntry(moduleUrl = import.meta.url): string {
  return fileURLToPath(new URL("./index.js", moduleUrl))
}

export function daemonCommandWords(entry = daemonWorkerEntry()): ServiceCommandWords {
  return {
    install: "domovoi daemon install",
    status: "domovoi daemon status",
    remove: "domovoi daemon remove",
    profileRecover: `domovoid profile recover --confirm-no-supervisor (domovoid is Node running ${entry})`,
  }
}

// The version in this package's manifest, beside dist/.
export function ownVersion(): string {
  const manifest = z.object({ version: z.string() }).parse(JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ))
  return manifest.version
}

export async function nodeDaemonCommandDependencies(): Promise<ServiceCommandDependencies> {
  const { nodeServiceEffects } = await import("./service/install.js")
  // The service runs as the user who asked for it, using this process's identity.
  const { uid, username } = userInfo()
  return {
    ...nodeServiceEffects(),
    platform: process.platform,
    execPath: daemonWorkerEntry(),
    runtime: process.execPath,
    home: homedir(),
    uid,
    user: username,
    environment: process.env,
    workingDirectory: process.cwd(),
    // Q408 A: names the runtime copy an install from an app's runtime
    // makes. Unread, only that install refuses.
    ...(() => { try { return { version: ownVersion() } } catch { return {} } })(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  }
}

export async function runDaemonCommand(
  args: readonly string[],
  dependencies?: ServiceCommandDependencies,
): Promise<number> {
  const stderr = dependencies?.stderr ?? ((text: string) => { process.stderr.write(text) })
  if (args.length !== 1 || !["install", "status", "remove"].includes(args[0]!)) {
    stderr("Usage: domovoi daemon install|status|remove\n")
    return 1
  }
  try {
    const { runServiceCommand } = await import("./service/install.js")
    return await runServiceCommand(["service", ...args], {
      ...dependencies ?? await nodeDaemonCommandDependencies(),
      words: dependencies?.words ?? daemonCommandWords(),
    })
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
