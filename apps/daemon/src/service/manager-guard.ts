import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

// The daemon test setup (apps/daemon/vitest.setup.ts) sets this to a directory.
// While it is set, the real service manager runner refuses every command and
// records it there: a unit test that reaches launchctl, systemctl, loginctl or
// the Task Scheduler without a fake fails, even where the code under test
// catches the refusal, and so does a CLI child that inherits the environment.
// On 2026-10-16 two tests asked the real launchctl about the operator's own
// login service. The native service tests clear it (test-native-service-gate.ts).
// Nothing outside the daemon test suite sets it.
export const serviceManagerRefusalVariable = "DOMOVOI_TEST_SERVICE_MANAGER_REFUSALS"

const shownArgumentLength = 120

export function refuseRealServiceManagerUnderTest(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const directory = environment[serviceManagerRefusalVariable]
  if (directory === undefined || directory === "") return
  // Encoded PowerShell scripts run to thousands of characters.
  const shown = [command, ...args.map((arg) => arg.length > shownArgumentLength ? `${arg.slice(0, shownArgumentLength)}...` : arg)].join(" ")
  try { writeFileSync(join(directory, `${process.pid}-${randomUUID()}`), shown, { flag: "wx" }) }
  catch { /* The throw below still refuses the command. */ }
  throw new Error(`A daemon test reached the real service manager: ${shown}. Inject fake run and capture effects, or gate the test as a native service test.`)
}
