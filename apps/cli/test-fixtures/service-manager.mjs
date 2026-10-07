// Test-only OS boundary for `domovoi daemon`: the daemon's own manager shim
// (apps/daemon/test-fixtures/service-manager.mjs), which answers systemctl,
// launchctl, loginctl and Task Scheduler from a log and refuses every other
// subprocess, plus /bin/ls. The runtime copy an install from an app makes
// (Q408) runs /bin/ls -lde to read a macOS access control list, which is a
// read, not a service manager. No real service is installed.
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import { promisify } from "node:util"

const original = childProcess.execFile
await import(new URL("../../daemon/test-fixtures/service-manager.mjs", import.meta.url).href)
const shimmed = childProcess.execFile

function execFile(command, ...rest) {
  return (command === "/bin/ls" ? original : shimmed)(command, ...rest)
}
// promisify(execFile) resolves { stdout, stderr }, as Node's own does.
execFile[promisify.custom] = (command, args, options = {}) => new Promise((resolve, reject) => {
  execFile(command, args, options, (error, stdout, stderr) => (error ? reject(Object.assign(error, { stdout, stderr })) : resolve({ stdout, stderr })))
})
childProcess.execFile = execFile
syncBuiltinESMExports()
