import assert from "node:assert/strict"
import test from "node:test"

import { launchdPlist, systemdUnit, windowsServiceCommand } from "./service-units.mjs"

test("supervises the daemon as a user service under systemd", () => {
  const unit = systemdUnit({ execPath: "/opt/domovoi/bin/domovoid" })
  assert.match(unit, /^\[Unit\]$/m)
  assert.match(unit, /^ExecStart=\/opt\/domovoi\/bin\/domovoid$/m)
  assert.match(unit, /^Restart=on-failure$/m)
  assert.match(unit, /^RestartSec=5$/m)
  assert.match(unit, /^WantedBy=default\.target$/m)
})

test("never asks systemd to run the daemon as root", () => {
  const unit = systemdUnit({ execPath: "/opt/domovoi/bin/domovoid" })
  assert.doesNotMatch(unit, /^User=root$/m)
  assert.doesNotMatch(unit, /WantedBy=multi-user\.target/)
})

test("keeps the daemon running under launchd", () => {
  const plist = launchdPlist({ execPath: "/opt/domovoi/bin/domovoid" })
  assert.match(plist, /<key>Label<\/key>\s*<string>sh\.domovoi\.domovoid<\/string>/)
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>/)
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/)
  assert.match(plist, /<string>\/opt\/domovoi\/bin\/domovoid<\/string>/)
})

test("registers the daemon with the Windows service manager", () => {
  assert.deepEqual(windowsServiceCommand({ execPath: "C:\\Program Files\\Domovoi\\domovoid.exe" }), {
    command: "sc.exe",
    args: [
      "create",
      "domovoid",
      "binPath=",
      "\"C:\\Program Files\\Domovoi\\domovoid.exe\"",
      "start=",
      "auto",
      "DisplayName=",
      "Domovoi daemon",
    ],
  })
})

for (const execPath of ["domovoid", "./domovoid", "", undefined]) {
  test(`refuses the unpinned systemd exec path ${JSON.stringify(execPath)}`, () => {
    assert.throws(() => systemdUnit({ execPath }), /absolute/)
  })
}

test("refuses a Windows exec path that is not absolute", () => {
  assert.throws(() => windowsServiceCommand({ execPath: "domovoid.exe" }), /absolute/)
})

for (const execPath of ["/opt/domovoi\nExecStart=/bin/sh", "/opt/domovoi\"x", "/opt/domovoi\u0000x"]) {
  test(`refuses an exec path that would break out of the unit: ${JSON.stringify(execPath)}`, () => {
    assert.throws(() => systemdUnit({ execPath }), /cannot contain/)
  })
}

test("carries plain environment settings into the unit", () => {
  const unit = systemdUnit({
    execPath: "/opt/domovoi/bin/domovoid",
    environment: { DOMOVOI_PORT: "7717" },
  })
  assert.match(unit, /^Environment="DOMOVOI_PORT=7717"$/m)
})

for (const key of ["DOMOVOI_TOKEN", "API_KEY", "DB_PASSWORD", "PAIRING_SECRET", "AWS_CREDENTIALS"]) {
  test(`refuses to write ${key} into a service file`, () => {
    assert.throws(
      () => systemdUnit({ execPath: "/opt/domovoi/bin/domovoid", environment: { [key]: "value" } }),
      /secret/,
    )
    assert.throws(
      () => launchdPlist({ execPath: "/opt/domovoi/bin/domovoid", environment: { [key]: "value" } }),
      /secret/,
    )
  })
}

test("escapes a value that would otherwise close the plist markup", () => {
  const plist = launchdPlist({
    execPath: "/opt/domovoi/bin/domovoid",
    environment: { DOMOVOI_LABEL: "a<b&c" },
  })
  assert.match(plist, /<string>a&lt;b&amp;c<\/string>/)
})

test("quotes an exec path that systemd would otherwise split into command items", () => {
  const unit = systemdUnit({ execPath: "/opt/Domovoi Suite/domovoid" })
  assert.match(unit, /^ExecStart="\/opt\/Domovoi Suite\/domovoid"$/m)
})

test("leaves an exec path without spaces unquoted", () => {
  assert.match(systemdUnit({ execPath: "/opt/domovoi/bin/domovoid" }), /^ExecStart=\/opt\/domovoi\/bin\/domovoid$/m)
})

test("keeps a spaced path as one launchd program argument", () => {
  const plist = launchdPlist({ execPath: "/opt/Domovoi Suite/domovoid" })
  assert.match(plist, /<string>\/opt\/Domovoi Suite\/domovoid<\/string>/)
})

for (const key of ["1PORT", "A-B", "", "DOMOVOI PORT"]) {
  test(`refuses the environment name ${JSON.stringify(key)} that systemd would drop`, () => {
    assert.throws(
      () => systemdUnit({ execPath: "/opt/domovoi/bin/domovoid", environment: { [key]: "1" } }),
      /environment name/,
    )
  })
}

test("restarts under launchd only when the daemon failed", () => {
  const plist = launchdPlist({ execPath: "/opt/domovoi/bin/domovoid" })
  assert.match(
    plist,
    /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/,
  )
})
