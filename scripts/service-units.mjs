const label = "sh.domovoi.domovoid"
const serviceName = "domovoid"
const displayName = "Domovoi daemon"
const description = "Domovoi execution daemon"
const secretName = /TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL/i
const forbidden = /["\u0000-\u001f]/

function assertExecutable(execPath, platform) {
  if (typeof execPath !== "string" || execPath === "") {
    throw new Error("the service needs an absolute path to domovoid")
  }
  if (forbidden.test(execPath)) {
    throw new Error("a service exec path cannot contain quotes, newlines, or control characters")
  }
  const absolute = platform === "win32" ? /^[A-Za-z]:\\/.test(execPath) : execPath.startsWith("/")
  if (!absolute) throw new Error(`${execPath} is not an absolute path to domovoid`)
  return execPath
}

function assertNoSecrets(environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (secretName.test(key)) {
      throw new Error(`${key} looks like a secret, and a service file is not where a secret is kept`)
    }
    if (forbidden.test(key) || forbidden.test(String(value))) {
      throw new Error("a service environment value cannot contain quotes, newlines, or control characters")
    }
  }
  return environment
}

function escapeXml(value) {
  return value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character])
}

export function systemdUnit({ execPath, environment = {} }) {
  assertExecutable(execPath, "linux")
  assertNoSecrets(environment)

  const settings = Object.entries(environment).map(([key, value]) => `Environment="${key}=${value}"`)
  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${execPath}`,
    ...settings,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

export function launchdPlist({ execPath, environment = {} }) {
  assertExecutable(execPath, "darwin")
  assertNoSecrets(environment)

  const settings = Object.entries(environment).flatMap(([key, value]) => [
    `      <key>${escapeXml(key)}</key>`,
    `      <string>${escapeXml(String(value))}</string>`,
  ])
  const variables = settings.length === 0
    ? []
    : ["    <key>EnvironmentVariables</key>", "    <dict>", ...settings, "    </dict>"]

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "  <dict>",
    "    <key>Label</key>",
    `    <string>${label}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    `      <string>${escapeXml(execPath)}</string>`,
    "    </array>",
    ...variables,
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <true/>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n")
}

export function windowsServiceCommand({ execPath }) {
  assertExecutable(execPath, "win32")
  return {
    command: "sc.exe",
    args: ["create", serviceName, "binPath=", `"${execPath}"`, "start=", "auto", "DisplayName=", displayName],
  }
}
