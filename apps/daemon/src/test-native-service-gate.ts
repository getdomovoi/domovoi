import { runningInCi } from "../vitest.global-setup.js"

// The native service tests install real jobs into the account that runs them:
// launchd agents in the gui domain, systemd user units, Windows scheduled tasks
// and job objects. A run that is interrupted, or whose cleanup fails, leaves
// such a job loaded in the developer's own session, so these tests run on CI,
// where every runner is thrown away, and on a developer machine only when the
// developer asks for them by name.
export const nativeServiceOptIn = "DOMOVOI_NATIVE_SERVICE_TESTS"

// One reading of CI for the whole daemon suite: the profile guard in the global
// setup already decides with it whether this run is a hosted runner.
export { runningInCi }

// A skipped test reports like a passing one, so a skip prints the reason and
// the way to opt in. The opt-in is exactly "1": any other value is a typo, not
// consent to load jobs into the developer's session.
export function nativeServiceTestsEnabled(
  manager: string,
  environment: NodeJS.ProcessEnv = process.env,
  // Straight to stderr: this suite's runs do not show console output, and a
  // reason nobody sees is no better than a silent skip.
  print: (line: string) => void = (line) => { process.stderr.write(`${line}\n`) },
): boolean {
  if (runningInCi(environment) || environment[nativeServiceOptIn] === "1") return true
  print(`Skipping the native ${manager} tests: they load real ${manager} jobs into this account, so they run only on CI. `
    + `Set ${nativeServiceOptIn}=1 to run them here.`)
  return false
}

// The gate comes first and the manager probe second, so a skipped run never
// asks the manager anything. The probe keeps its own rules: it may still skip
// where the manager is absent, or throw where CI requires it.
export function nativeServiceTestsRun(
  manager: string,
  managerAvailable: () => boolean,
  environment: NodeJS.ProcessEnv = process.env,
  print?: (line: string) => void,
): boolean {
  return nativeServiceTestsEnabled(manager, environment, print) && managerAvailable()
}
