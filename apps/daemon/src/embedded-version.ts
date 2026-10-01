import { execFile } from "node:child_process"
import { promisify } from "node:util"

// The OpenCode and Kilo permission names, tool ids and rule shapes the
// adapter trusts were read from particular server versions, and the SDKs
// start whichever `opencode` or `kilo` executable is first on PATH. A default
// factory reads that executable's version before starting it and starts
// nothing outside the minor line the lists were tested on (security review
// round 4 of #687). The gated contract test (embedded-provider-contract
// .test.ts) fails when a tested server's lists drift.

export type TestedVersion = Readonly<{
  command: string
  providerName: string
  // The tested minor line, such as "1.18": any 1.18.x is accepted.
  line: string
  // The release the lists were read from, named in a refusal.
  tested: string
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

// The executable's version when it is on the tested minor line; otherwise an
// error naming the version found and the one tested.
export async function requireTestedVersion(
  expected: TestedVersion,
  read: (command: string) => Promise<string> = readExecutableVersion,
): Promise<string> {
  let output: string
  try {
    output = await read(expected.command)
  } catch {
    output = ""
  }
  const found = /(\d+)\.(\d+)\.(\d+)/u.exec(output)
  if (found === null) {
    throw new Error(
      `Domovoi could not read the version of ${expected.providerName} (\`${expected.command} --version\`), so it does not start it. `
      + `Domovoi was tested with ${expected.providerName} ${expected.tested} (any ${expected.line}.x).`,
    )
  }
  const version = found[0]
  if (`${found[1]}.${found[2]}` !== expected.line) {
    throw new Error(
      `${expected.providerName} ${version} is not a version Domovoi was tested with, so Domovoi does not start it: `
      + `it was tested with ${expected.providerName} ${expected.tested} (any ${expected.line}.x). Install ${expected.providerName} ${expected.line}.x to use it with Domovoi.`,
    )
  }
  return version
}
