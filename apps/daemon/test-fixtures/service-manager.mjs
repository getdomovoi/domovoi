// Test-only OS boundary. The distributed CLI still parses its real arguments,
// writes real files, and builds its real launch command. No real service is
// installed on the account running this test.
import childProcess from "node:child_process"
import { appendFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import os from "node:os"
import path from "node:path"

// Native managers are per OS user, even with a different shell HOME. Give the
// test process an isolated OS-user home as well as an isolated daemon profile.
const user = os.userInfo()
os.userInfo = () => ({ ...user, homedir: process.env.DOMOVOI_TEST_SERVICE_HOME ?? process.env.HOME })

let held = false
childProcess.execFile = (command, args, options, callback) => {
  const powershell = command.endsWith("\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  if (!["systemctl", "launchctl", "schtasks"].includes(command) && !powershell) {
    throw new Error(`Unexpected install subprocess: ${command}`)
  }
  appendFileSync(process.env.DOMOVOI_TEST_MANAGER_LOG, `${JSON.stringify({ command, args })}\n`)
  // Status and removal first ask what the job runs (security review rounds 1
  // and 2 on #574). Answer with what this CLI installed: its own Node and
  // entry, the runtime service.json records.
  const home = process.env.DOMOVOI_TEST_SERVICE_HOME ?? process.env.HOME
  const script = powershell ? Buffer.from(args.at(-1), "base64").toString("utf16le") : ""
  const action = {
    path: `"${process.execPath}"`,
    arguments: `"${process.argv[1]}" --service-config "${path.win32.join(home, ".domovoi", "service.json")}"`,
    enabled: true, state: 1,
  }
  const output = powershell
    ? script.includes("domovoi-task-action:")
      ? `domovoi-task-action:${JSON.stringify(action)}\r\n`
      : `domovoi-task:${script.includes("$folder.DeleteTask(") ? "deleted" : "1"}\r\n`
    : command === "launchctl" && args[0] === "print"
      ? `\tpath = ${path.posix.join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")}\n\tstate = running\n`
      : ""
  if (held || process.env.DOMOVOI_TEST_MANAGER_HOLD !== "1") {
    callback(null, output, "")
    return
  }
  held = true
  // A real CLI waits on its native-manager boundary while the test starts a
  // competing CLI. IPC supplies ordering, not a timing guess or extra sleep.
  if (!process.send || !options.signal) throw new Error("The held manager needs IPC and the production deadline")
  options.signal.throwIfAborted()
  const cleanup = () => {
    clearTimeout(watchdog)
    process.removeListener("message", resume)
    options.signal.removeEventListener("abort", abort)
    process.disconnect()
  }
  const resume = (message) => {
    if (message !== "resume") throw new Error("Unexpected manager control message")
    cleanup()
    callback(null, output, "")
  }
  const abort = () => { cleanup(); callback(options.signal.reason, "", "") }
  // Test fixture lifetime only. Never leave an abandoned CLI behind if the
  // parent dies before delivering its resume or SIGKILL cleanup.
  const watchdog = setTimeout(() => process.exit(1), 60_000)
  process.once("message", resume)
  options.signal.addEventListener("abort", abort, { once: true })
  process.send({ state: "manager-held" })
}
syncBuiltinESMExports()
