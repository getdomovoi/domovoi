// Test-only OS boundary. The distributed CLI still parses its real arguments,
// writes real files, and builds its real launch command. No real service is
// installed on the account running this test.
import childProcess from "node:child_process"
import { appendFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"

childProcess.execFile = (command, args, _options, callback) => {
  if (!["systemctl", "launchctl", "schtasks"].includes(command)) {
    throw new Error(`Unexpected install subprocess: ${command}`)
  }
  appendFileSync(process.env.DOMOVOI_TEST_MANAGER_LOG, `${JSON.stringify({ command, args })}\n`)
  callback(null, "", "")
}
syncBuiltinESMExports()
