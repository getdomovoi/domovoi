import type { WslMachineFact } from "./wsl-discovery.js"
import { WslError, type WslFailureKind } from "./wsl-run.js"

export type WslCommandDependencies = {
  platform: NodeJS.Platform
  discover: () => Promise<WslMachineFact[]>
  stdout: (text: string) => void
  stderr: (text: string) => void
}

const usage = "Usage: domovoid wsl list\n"

// Why a running distribution could not be asked, in a word or two, so the
// listing says what to fix rather than only that something is unknown.
const failureWords: Record<WslFailureKind, string> = {
  absent: "WSL is not installed",
  denied: "denied",
  "timed-out": "timed out",
  unavailable: "wsl.exe failed",
  corrupt: "endpoint file unreadable",
}

const daemonWords: Record<WslMachineFact["daemon"], (fact: WslMachineFact) => string> = {
  present: (fact) => `daemon at ${fact.endpoint}`,
  absent: () => "no daemon",
  unknown: (fact) => (fact.failure ? `could not be asked (${failureWords[fact.failure]})` : "could not be asked"),
}

function describe(fact: WslMachineFact, nameWidth: number): string {
  const columns = [
    fact.distribution.padEnd(nameWidth),
    `WSL ${fact.version}`,
    fact.state.padEnd("stopped".length),
    daemonWords[fact.daemon](fact),
  ]
  if (fact.default) columns.push("default")
  return `${columns.join("  ")}\n`
}

export async function runWslCommand(
  args: readonly string[],
  dependencies: WslCommandDependencies,
): Promise<number> {
  if (args[0] !== "wsl") return 1
  if (args[1] !== "list" || args.length > 2) {
    dependencies.stderr(usage)
    return 1
  }
  if (dependencies.platform !== "win32") {
    dependencies.stderr("domovoid wsl list asks wsl.exe, which exists only on Windows.\n")
    return 1
  }

  let facts: WslMachineFact[]
  try {
    facts = await dependencies.discover()
  } catch (error) {
    // A machine without WSL has answered the question. Every other failure is
    // reported as the kind it was, with the remedy the reader already carries.
    if (error instanceof WslError && error.kind === "absent") {
      dependencies.stdout(`${error.message}\n`)
      return 0
    }
    dependencies.stderr(`Could not ask wsl.exe: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }

  if (facts.length === 0) {
    dependencies.stdout("No WSL distribution is installed.\n")
    return 0
  }
  const nameWidth = Math.max(...facts.map((fact) => fact.distribution.length))
  for (const fact of facts) dependencies.stdout(describe(fact, nameWidth))
  return 0
}
