import { GitWorkspaceService } from "./workspace.js"
import { trackRestoreCommand } from "./workspace-restore-lease.js"
import { execFile } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { holdRecoveryWriter } from "./test-workspace-recovery.js"
import { validateOperationDeadlineBudget } from "./operation-deadline.js"

const [root, repository, bundle, mode = "before-git", holderBudget] = process.argv.slice(2)
if (!root) throw new Error("Missing workspace recovery fixture root")
const holderMs = Number(holderBudget)
validateOperationDeadlineBudget(holderMs)

if (mode === "hold-child") {
  writeFileSync(join(root, "child-ready"), JSON.stringify({ pid: process.pid, parentPid: process.ppid }))
  holdRecoveryWriter(root, holderMs, () => {
    writeFileSync(join(root, "child-expired"), JSON.stringify({ pid: process.pid, holderMs }))
    process.exit(1)
  }, () => {
    writeFileSync(join(root, "child-forced"), JSON.stringify({ pid: process.pid }))
    process.kill(process.pid, "SIGKILL")
  })
} else {
  if (!repository || !bundle || !process.send) throw new Error("Missing workspace recovery fixture input")
  const workspace = new GitWorkspaceService(root)
  workspace.inspect = async () => {
    process.send!({ state: "claimed" })
    if (mode !== "before-git") {
      const abort = new AbortController()
      if (mode === "after-git-abort") process.once("message", () => abort.abort())
      const quote = (value: string) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`
      const command = [process.execPath, "--import", import.meta.resolve("tsx"), fileURLToPath(import.meta.url), root, repository, bundle, "hold-child", String(holderMs)]
        .map(quote).join(" ")
      await trackRestoreCommand(() => promisify(execFile)("git", ["-C", repository, "-c", `alias.hold=!${command}`, "hold"], { signal: abort.signal, killSignal: "SIGKILL" }))
    } else {
      await new Promise<void>((resolve) => process.once("message", () => resolve()))
    }
    throw new Error("The fixture must be killed while it owns the restore")
  }
  await workspace.restoreSessionFromBundle(bundle, "session-recovery", { repositoryPath: repository })
}
