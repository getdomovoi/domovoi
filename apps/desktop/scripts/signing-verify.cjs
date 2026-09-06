const { execFile } = require("node:child_process")
const { join } = require("node:path")
const { promisify } = require("node:util")

const execute = promisify(execFile)
const verificationBudgetMs = 120_000

function verifier(run = execute, now = () => performance.now()) {
  const expires = now() + verificationBudgetMs
  return async (command, args) => {
    const timeout = Math.ceil(expires - now())
    if (timeout <= 0) throw new Error("Desktop signature verification exceeded its two-minute deadline")
    const result = await run(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" })
    if (now() >= expires) throw new Error("Desktop signature verification exceeded its two-minute deadline")
    return result
  }
}

async function verifyMacApplication(path, teamId, run, now) {
  const check = verifier(run, now)
  await check("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", path])
  const identity = await check("/usr/bin/codesign", ["--display", "--verbose=4", path])
  const details = `${identity.stdout}\n${identity.stderr}`
  if (!details.split(/\r?\n/u).includes(`TeamIdentifier=${teamId}`) || !/^Authority=Developer ID Application:/mu.test(details)) {
    throw new Error("The macOS application is not signed with a Developer ID Application certificate from APPLE_TEAM_ID")
  }
  // The built-in v26 notarizer staples before afterSign. Validate that fact,
  // rather than trusting the configuration or a log saying submission started.
  await check("/usr/bin/xcrun", ["stapler", "validate", "-v", path])
}

async function verifyWindowsFiles(paths, publisher, run, now) {
  const check = verifier(run, now)
  for (const path of paths) {
    await check("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-File", join(__dirname, "verify-authenticode.ps1"),
      "-Artifact", path, "-Publisher", publisher,
    ])
  }
}

module.exports = { verifyMacApplication, verifyWindowsFiles, verificationBudgetMs }
