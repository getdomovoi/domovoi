import { execFile } from "node:child_process"
import { promisify } from "node:util"

// The OpenCode and Kilo permission names, tool ids and rule shapes the
// adapter trusts were read from particular server releases, and the SDKs
// start whichever `opencode` or `kilo` executable is first on PATH. A default
// factory reads that executable's version before starting it and starts only
// a release on the exact list that passed the gated contract test
// (embedded-provider-contract.test.ts), which fails when a tested server's
// lists drift. A patch release can change those lists, so a release is added
// here only after the contract passes against it (security review rounds 4
// and 5 of #687).

export type TestedVersion = Readonly<{
  command: string
  providerName: string
  // The releases that passed the live contract, such as ["1.18.32"].
  tested: readonly string[]
}>

const versionReadTimeoutMs = 10_000

// `<command> --version`, run as the SDK runs the server: by name, on the
// daemon's PATH and environment. On Windows the name resolves through the
// shell, as the SDK's cross-spawn resolves it.
export async function readExecutableVersion(command: string): Promise<string> {
  const { stdout } = await promisify(execFile)(command, ["--version"], {
    timeout: versionReadTimeoutMs,
    windowsHide: true,
    shell: process.platform === "win32",
  })
  return stdout
}

// OpenCode 1.18.33 and Kilo 7.8.1 print the bare version and a newline, with
// no name or `v` prefix. Anything else, such as an update notice or a second
// line, is not read as a version.
const bareVersion = /^\d+\.\d+\.\d+$/u

function testedList(expected: TestedVersion): string {
  const releases = expected.tested
  const listed = releases.length <= 1
    ? releases.join("")
    : `${releases.slice(0, -1).join(", ")} and ${releases.at(-1) ?? ""}`
  return `${expected.providerName} ${listed}`
}

// The executable's version when it is a tested release; otherwise an error
// naming the version found and the releases tested.
export async function requireTestedVersion(
  expected: TestedVersion,
  read: (command: string) => Promise<string> = readExecutableVersion,
): Promise<string> {
  let output: string
  try {
    output = (await read(expected.command)).trim()
  } catch {
    output = ""
  }
  if (!bareVersion.test(output)) {
    throw new Error(
      `Domovoi could not read the version of ${expected.providerName} (\`${expected.command} --version\` did not print one version line), so it does not start it. `
      + `Domovoi was tested with ${testedList(expected)}.`,
    )
  }
  if (!expected.tested.includes(output)) {
    throw new Error(
      `${expected.providerName} ${output} is not a release Domovoi was tested with, so Domovoi does not start it: `
      + `it was tested with ${testedList(expected)}. Install one of those releases to use it with Domovoi.`,
    )
  }
  return output
}
