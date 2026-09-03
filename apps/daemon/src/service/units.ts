export type ServiceEnvironment = Readonly<Record<string, string>>

export type ServiceUnitInput = {
  execPath: string
  environment?: ServiceEnvironment
}

const label = "sh.domovoi.domovoid"
const description = "Domovoi execution daemon"
const secretName = /TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL/i
const environmentName = /^[A-Za-z_][A-Za-z0-9_]*$/

// Both service files this writes are read by a unix service manager, so an
// absolute path here is a posix one.
// A quote or a control character would let a value break out of the file or
// command it is written into. Checked by code point because a regular
// expression that contains a control character is itself hard to review.
function hasForbiddenCharacter(value: string): boolean {
  return value.includes("\"") || [...value].some((character) => character < " ")
}

function assertExecutable(execPath: string): string {
  if (typeof execPath !== "string" || execPath === "") {
    throw new Error("the service needs an absolute path to domovoid")
  }
  if (hasForbiddenCharacter(execPath)) {
    throw new Error("a service exec path cannot contain quotes, newlines, or control characters")
  }
  if (!execPath.startsWith("/")) throw new Error(`${execPath} is not an absolute path to domovoid`)
  return execPath
}

function assertNoSecrets(
  environment: ServiceEnvironment,
  { names = false }: { names?: boolean } = {},
): ServiceEnvironment {
  for (const [key, value] of Object.entries(environment)) {
    if (names && !environmentName.test(key)) {
      throw new Error(`${JSON.stringify(key)} is not an environment name systemd would pass on`)
    }
    if (secretName.test(key)) {
      throw new Error(`${key} looks like a secret, and a service file is not where a secret is kept`)
    }
    if (hasForbiddenCharacter(key) || hasForbiddenCharacter(String(value))) {
      throw new Error("a service environment value cannot contain quotes, newlines, or control characters")
    }
  }
  return environment
}

function systemdArgument(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}

const escapes: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" }

function escapeXml(value: string): string {
  return value.replace(/[<>&]/g, (character) => escapes[character] ?? character)
}

export function systemdUnit({ execPath, environment = {} }: ServiceUnitInput): string {
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

export function launchdPlist({ execPath, environment = {} }: ServiceUnitInput): string {
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
