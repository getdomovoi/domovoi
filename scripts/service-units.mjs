const label = "sh.domovoi.domovoid"
const description = "Domovoi execution daemon"
const secretName = /TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL/i
const forbidden = /["\u0000-\u001f]/
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

// Both service files this writes are read by a unix service manager, so an
// absolute path here is a posix one.
function assertExecutable(execPath) {
  if (typeof execPath !== "string" || execPath === "") {
    throw new Error("the service needs an absolute path to domovoid")
  }
  if (forbidden.test(execPath)) {
    throw new Error("a service exec path cannot contain quotes, newlines, or control characters")
  }
  if (!execPath.startsWith("/")) throw new Error(`${execPath} is not an absolute path to domovoid`)
  return execPath
}

function assertNoSecrets(environment, { names = false } = {}) {
  for (const [key, value] of Object.entries(environment)) {
    if (names && !environmentName.test(key)) {
      throw new Error(`${JSON.stringify(key)} is not an environment name systemd would pass on`)
    }
    if (secretName.test(key)) {
      throw new Error(`${key} looks like a secret, and a service file is not where a secret is kept`)
    }
    if (forbidden.test(key) || forbidden.test(String(value))) {
      throw new Error("a service environment value cannot contain quotes, newlines, or control characters")
    }
  }
  return environment
}

function systemdArgument(value) {
  return /\s/.test(value) ? `"${value}"` : value
}

function escapeXml(value) {
  return value.replace(/[<>&]/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[character])
}

export function systemdUnit({ execPath, environment = {} }) {
  assertExecutable(execPath)
  assertNoSecrets(environment, { names: true })

  const settings = Object.entries(environment).map(([key, value]) => `Environment="${key}=${value}"`)
  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${systemdArgument(execPath)}`,
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
  assertExecutable(execPath)
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
    "    <dict>",
    "      <key>SuccessfulExit</key>",
    "      <false/>",
    "    </dict>",
    "  </dict>",
    "</plist>",
    "",
  ].join("\n")
}
