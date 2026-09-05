export type ServiceUnitInput = {
  execPath: string
  args?: readonly string[]
}

const label = "sh.domovoi.domovoid"
const description = "Domovoi execution daemon"

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

function assertArguments(args: readonly string[]): void {
  for (const argument of args) {
    if (!argument || hasForbiddenCharacter(argument)) throw new Error("a service argument cannot contain quotes, newlines, or control characters")
  }
}

function systemdArgument(value: string): string {
  // systemd performs its own specifier, variable and backslash expansion.
  // No shell is involved. Double the expansion introducers for literal paths.
  const escaped = value.replaceAll("\\", "\\\\").replaceAll("%", "%%").replaceAll("$", () => "$$")
  return /[\s'"\\]/.test(value) ? `"${escaped}"` : escaped
}

const escapes: Record<string, string> = { "<": "&lt;", ">": "&gt;", "&": "&amp;" }

function escapeXml(value: string): string {
  return value.replace(/[<>&]/g, (character) => escapes[character] ?? character)
}

export function systemdUnit({ execPath, args = [] }: ServiceUnitInput): string {
  assertExecutable(execPath)
  assertArguments(args)

  return [
    "[Unit]",
    `Description=${description}`,
    "After=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `ExecStart=${[execPath, ...args].map(systemdArgument).join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n")
}

export function launchdPlist({ execPath, args = [] }: ServiceUnitInput): string {
  assertExecutable(execPath)
  assertArguments(args)

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
    ...args.map((argument) => `      <string>${escapeXml(argument)}</string>`),
    "    </array>",
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
