import { mkdir, writeFile } from "node:fs/promises"
import { posix } from "node:path"

import { launchdPlist, systemdUnit } from "./service-units.mjs"

const serviceName = "domovoid"
const unitFile = `${serviceName}.service`
const agentFile = "sh.domovoi.domovoid.plist"

function assertHome(home) {
  if (typeof home !== "string" || home === "") {
    throw new Error("the install needs a home directory to put the service file in")
  }
  return home
}

const displayName = "Domovoi daemon"

function assertUser(user) {
  if (typeof user !== "string" || user === "" || /["\u0000-\u001f]/.test(user)) {
    throw new Error("the logon task needs the user it runs as")
  }
  return user
}

function assertExecutable(execPath) {
  if (typeof execPath !== "string" || !/^[A-Za-z]:\\/.test(execPath) || /["\u0000-\u001f]/.test(execPath)) {
    throw new Error(`${execPath} is not an absolute path to domovoid`)
  }
  return execPath
}

function assertUid(uid) {
  if (!Number.isInteger(uid) || uid < 0) {
    throw new Error("launchd needs the user the agent is installed for")
  }
  return uid
}

// A service is installed for the user who asked for it: a systemd user unit, a
// launchd agent in that user's own LaunchAgents, or a Windows service. Nothing
// here writes to a system-wide location or asks for elevation.
export function servicePlan({ platform, execPath, home, uid, user, environment = {} }) {
  if (platform === "linux") {
    return {
      path: posix.join(assertHome(home), ".config", "systemd", "user", unitFile),
      contents: systemdUnit({ execPath, environment }),
      commands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", "--now", unitFile] },
      ],
    }
  }

  if (platform === "darwin") {
    const path = posix.join(assertHome(home), "Library", "LaunchAgents", agentFile)
    return {
      path,
      contents: launchdPlist({ execPath, environment }),
      commands: [{ command: "launchctl", args: ["bootstrap", `gui/${assertUid(uid)}`, path] }],
    }
  }

  if (platform === "win32") {
    // A Windows service created with sc.exe runs as LocalSystem and belongs to
    // the machine, which is neither what the systemd user unit nor the launchd
    // agent does. A logon task runs as the user who asked, with their own
    // privileges, and needs no elevation to install.
    return {
      commands: [
        {
          command: "schtasks",
          args: [
            "/create",
            "/tn",
            displayName,
            "/tr",
            `"${assertExecutable(execPath)}"`,
            "/sc",
            "onlogon",
            "/ru",
            assertUser(user),
            "/rl",
            "LIMITED",
            "/f",
          ],
        },
        { command: "schtasks", args: ["/run", "/tn", displayName] },
      ],
    }
  }

  throw new Error(`${platform} has no service manager this knows how to install into`)
}

async function writeUnit(path, contents) {
  // Every path a plan names is a posix one, because the only platforms that
  // get a file are the ones that use them.
  await mkdir(posix.dirname(path), { recursive: true })
  await writeFile(path, contents, { mode: 0o600 })
}

// The file is written before the service manager is asked to load it, and a
// write that fails stops the install rather than leaving a service pointing at
// a unit that is not there.
export async function installService({
  platform,
  execPath,
  home,
  uid,
  user,
  environment = {},
  write = writeUnit,
  run,
}) {
  const plan = servicePlan({ platform, execPath, home, uid, user, environment })
  if (plan.path) await write(plan.path, plan.contents)
  for (const { command, args } of plan.commands) await run(command, args)
  return plan
}

const usage = "Usage: domovoid service install\n"

// The command is the only thing here that talks to a person: it reports where
// the service went, or what the service manager said when it refused, and
// never invents a success.
export async function runServiceCommand(args, dependencies) {
  if (args[0] !== "service") return 1
  if (args[1] !== "install" || args.length > 2) {
    dependencies.stderr(usage)
    return 1
  }

  let plan
  try {
    plan = await installService({
      platform: dependencies.platform,
      execPath: dependencies.execPath,
      home: dependencies.home,
      uid: dependencies.uid,
      user: dependencies.user,
      ...(dependencies.environment ? { environment: dependencies.environment } : {}),
      write: dependencies.write,
      run: dependencies.run,
    })
  } catch (error) {
    dependencies.stderr(`${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  dependencies.stdout(
    plan.path
      ? `Installed the Domovoi daemon service at ${plan.path}\n`
      : `Installed the Domovoi daemon service as ${serviceName}\n`,
  )
  return 0
}
