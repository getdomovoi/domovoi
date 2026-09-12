import { GitWorkspaceService } from "./workspace.js"
import { trackRestoreCommand } from "./workspace-restore-lease.js"
import { execFile } from "node:child_process"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

const [root, repository, bundle, mode = "before-git"] = process.argv.slice(2)
if (!root) throw new Error("Missing workspace recovery fixture root")

if (mode === "hold-child") {
  writeFileSync(join(root, "child-ready"), JSON.stringify({ pid: process.pid, parentPid: process.ppid }))
  const timeout = setTimeout(() => process.exit(1), 20_000)
  const timer = setInterval(() => {
    if (!existsSync(join(root, "child-release"))) return
    clearTimeout(timeout)
    clearInterval(timer)
  }, 25)
} else {
  if (!repository || !bundle || !process.send) throw new Error("Missing workspace recovery fixture input")
  const workspace = new GitWorkspaceService(root)
  workspace.inspect = async () => {
    process.send!({ state: "claimed" })
    if (mode === "during-git") {
      const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
      const command = [process.execPath, "--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), root, repository, bundle, "hold-child"]
        .map(quote).join(" ")
      await trackRestoreCommand(() => promisify(execFile)("git", ["-C", repository, "-c", `alias.hold=!${command}`, "hold"]))
    } else {
      await new Promise<void>((resolve) => process.once("message", () => resolve()))
    }
    throw new Error("The fixture must be killed while it owns the restore")
  }
  await workspace.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository })
}
