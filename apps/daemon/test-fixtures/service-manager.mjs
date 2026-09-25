// Test-only OS boundary. The distributed CLI still parses its real arguments,
// writes real files, and builds its real launch command. No real service is
// installed on the account running this test.
import childProcess from "node:child_process"
import { appendFileSync, readFileSync } from "node:fs"
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
  // Install, status and removal first ask what the job runs (security review
  // rounds 1 to 3 on #574). Answer with what this CLI installed, its own Node
  // and entry, once an earlier call in this log registered it and no later
  // one removed it. Each CLI run is its own process, so the log is the state.
  const home = process.env.DOMOVOI_TEST_SERVICE_HOME ?? process.env.HOME
  const script = powershell ? Buffer.from(args.at(-1), "base64").toString("utf16le") : ""
  const decode = (entry) => entry.command.endsWith("powershell.exe") ? Buffer.from(entry.args.at(-1), "base64").toString("utf16le") : ""
  let registered = false
  for (const line of readFileSync(process.env.DOMOVOI_TEST_MANAGER_LOG, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line)
    if ((entry.command === "schtasks" && entry.args[0] === "/create") || (entry.command === "launchctl" && entry.args[0] === "bootstrap")) registered = true
    if (decode(entry).includes("$folder.DeleteTask(") || (entry.command === "launchctl" && entry.args[0] === "bootout")) registered = false
  }
  const action = {
    path: `"${process.execPath}"`,
    arguments: `"${process.argv[1]}" --service-config "${path.win32.join(home, ".domovoi", "service.json")}"`,
    enabled: true, state: 1,
  }
  const printed = command === "launchctl" && args[0] === "print"
  const output = powershell
    ? !registered && !script.includes("$folder.DeleteTask(")
      ? "domovoi-task:missing\r\n"
      : script.includes("domovoi-task-action:")
        ? `domovoi-task-action:${JSON.stringify(action)}\r\n`
        : `domovoi-task:${script.includes("$folder.DeleteTask(") ? "deleted" : "1"}\r\n`
    : printed && registered
      ? `\tpath = ${path.posix.join(home, "Library", "LaunchAgents", "sh.domovoi.domovoid.plist")}\n\tstate = running\n`
      : ""
  if (printed && !registered) {
    const error = Object.assign(new Error("Could not find service"), { code: 113 })
    callback(error, "", 'Could not find service "sh.domovoi.domovoid" in domain for user gui: 501')
    return
  }
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
