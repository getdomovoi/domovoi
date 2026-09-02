import assert from "node:assert/strict"
import test from "node:test"

import { installService, runServiceCommand, servicePlan } from "./service-install.mjs"

const execPath = "/opt/domovoi/bin/domovoid"
const home = "/home/me"

test("installs a systemd user unit and enables it", () => {
  const plan = servicePlan({ platform: "linux", execPath, home, uid: 1000 })
  assert.equal(plan.path, "/home/me/.config/systemd/user/domovoid.service")
  assert.match(plan.contents, /^ExecStart=\/opt\/domovoi\/bin\/domovoid$/m)
  assert.deepEqual(plan.commands, [
    { command: "systemctl", args: ["--user", "daemon-reload"] },
    { command: "systemctl", args: ["--user", "enable", "--now", "domovoid.service"] },
  ])
})

test("installs a launchd agent for the user who asked for it", () => {
  const plan = servicePlan({ platform: "darwin", execPath, home, uid: 501 })
  assert.equal(plan.path, "/home/me/Library/LaunchAgents/sh.domovoi.domovoid.plist")
  assert.match(plan.contents, /<key>Label<\/key>/)
  assert.deepEqual(plan.commands, [
    {
      command: "launchctl",
      args: ["bootstrap", "gui/501", "/home/me/Library/LaunchAgents/sh.domovoi.domovoid.plist"],
    },
  ])
})

test("starts the daemon at logon for the user who asked, without writing a file", () => {
  const plan = servicePlan({
    platform: "win32",
    execPath: "C:\\Program Files\\Domovoi\\domovoid.exe",
    home: "C:\\Users\\me",
    user: "me",
  })
  assert.equal(plan.path, undefined)
  assert.equal(plan.contents, undefined)
  assert.deepEqual(plan.commands, [
    {
      command: "schtasks",
      args: [
        "/create",
        "/tn",
        "Domovoi daemon",
        "/tr",
        "\"C:\\Program Files\\Domovoi\\domovoid.exe\"",
        "/sc",
        "onlogon",
        "/ru",
        "me",
        "/rl",
        "LIMITED",
        "/f",
      ],
    },
    { command: "schtasks", args: ["/run", "/tn", "Domovoi daemon"] },
  ])
})

test("never installs a Windows service that would run as the machine", () => {
  const plan = servicePlan({
    platform: "win32",
    execPath: "C:\\Domovoi\\domovoid.exe",
    home: "C:\\Users\\me",
    user: "me",
  })
  const flattened = plan.commands.map((entry) => `${entry.command} ${entry.args.join(" ")}`).join("\n")
  assert.doesNotMatch(flattened, /sc\.exe/)
  assert.doesNotMatch(flattened, /LocalSystem/i)
  assert.match(flattened, /\/rl LIMITED/)
})

test("refuses a Windows install with no user to run it as", () => {
  assert.throws(
    () => servicePlan({ platform: "win32", execPath: "C:\\Domovoi\\domovoid.exe", home: "C:\\Users\\me" }),
    /user/,
  )
})

test("names a posix path whatever machine planned the install", () => {
  for (const platform of ["linux", "darwin"]) {
    const plan = servicePlan({ platform, execPath, home, uid: 501 })
    assert.doesNotMatch(plan.path, /\\/)
    assert.match(plan.path, /^\/home\/me\//)
  }
})

test("refuses a platform with no service manager it knows", () => {
  assert.throws(() => servicePlan({ platform: "aix", execPath, home, uid: 1000 }), /aix/)
})

test("refuses to guess where a user's files live", () => {
  assert.throws(() => servicePlan({ platform: "linux", execPath, home: "", uid: 1000 }), /home/)
})

test("refuses a launchd install with no user to install it for", () => {
  assert.throws(() => servicePlan({ platform: "darwin", execPath, home }), /user/)
})

test("carries a refused secret out of the generator rather than writing it", () => {
  assert.throws(
    () => servicePlan({ platform: "linux", execPath, home, uid: 1000, environment: { API_KEY: "x" } }),
    /secret/,
  )
})

test("writes the unit before it asks the service manager to load it", async () => {
  const events = []
  await installService({
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async (path) => void events.push(`write ${path}`),
    run: async (command, args) => void events.push(`run ${command} ${args.join(" ")}`),
  })

  assert.deepEqual(events, [
    "write /home/me/.config/systemd/user/domovoid.service",
    "run systemctl --user daemon-reload",
    "run systemctl --user enable --now domovoid.service",
  ])
})

test("asks the Windows scheduler without writing anything", async () => {
  const written = []
  const ran = []
  await installService({
    platform: "win32",
    execPath: "C:\\Domovoi\\domovoid.exe",
    home: "C:\\Users\\me",
    user: "me",
    write: async (path, contents) => void written.push({ path, contents }),
    run: async (command, args) => void ran.push(`${command} ${args[0]}`),
  })

  assert.deepEqual(written, [])
  assert.deepEqual(ran, ["schtasks /create", "schtasks /run"])
})

test("does not ask the service manager for anything if the unit could not be written", async () => {
  const ran = []
  await assert.rejects(installService({
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async () => {
      throw new Error("read-only file system")
    },
    run: async (command, args) => void ran.push(`${command} ${args.join(" ")}`),
  }), /read-only/)
  assert.deepEqual(ran, [])
})

test("runs the install from the command line for this machine", async () => {
  const written = []
  const ran = []
  const code = await runServiceCommand(["service", "install"], {
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async (path, contents) => void written.push({ path, contents }),
    run: async (command, args) => void ran.push(`${command} ${args.join(" ")}`),
    stdout: () => {},
    stderr: () => {},
  })

  assert.equal(code, 0)
  assert.equal(written.length, 1)
  assert.equal(ran.length, 2)
})

test("says where the service was installed", async () => {
  const printed = []
  await runServiceCommand(["service", "install"], {
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async () => {},
    run: async () => {},
    stdout: (text) => printed.push(text),
    stderr: () => {},
  })
  assert.match(printed.join(""), /systemd\/user\/domovoid\.service/)
})

test("reports a service manager that refused the install", async () => {
  const printed = []
  const code = await runServiceCommand(["service", "install"], {
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async () => {},
    run: async () => {
      throw new Error("Failed to connect to bus")
    },
    stdout: () => {},
    stderr: (text) => printed.push(text),
  })
  assert.equal(code, 1)
  assert.match(printed.join(""), /bus/)
})

test("prints usage for a service subcommand it does not have", async () => {
  const printed = []
  const code = await runServiceCommand(["service", "uninstall"], {
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async () => {},
    run: async () => {},
    stdout: () => {},
    stderr: (text) => printed.push(text),
  })
  assert.equal(code, 1)
  assert.match(printed.join(""), /Usage/)
})

test("leaves another command alone", async () => {
  const code = await runServiceCommand(["pair"], {
    platform: "linux",
    execPath,
    home,
    uid: 1000,
    write: async () => {},
    run: async () => {},
    stdout: () => {},
    stderr: () => {},
  })
  assert.equal(code, 1)
})
