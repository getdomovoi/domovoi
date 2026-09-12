import { readFileSync } from "node:fs"
import { runInNewContext } from "node:vm"

import ts from "typescript"
import { describe, expect, it } from "vitest"

import { wslTaskFixtureBudgets } from "./wsl-task-test-support.js"

function registerNativeProof(phase: string, registrations: number[]) {
  const source = readFileSync(new URL("./wsl-task.native.test.ts", import.meta.url), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  }).outputText
  // Execute module registration with no test body and no OS effects. This
  // catches a consumer that ignores the runner's env even if the helper works.
  runInNewContext(compiled, {
    exports: {},
    process: { platform: "win32", env: {
      DOMOVOI_WSL_NATIVE_SERVICE: "1", DOMOVOI_WSL_NATIVE_SERVICE_BUDGET_MS: phase,
    } },
    require: (name: string) => {
      if (name === "./wsl-task-test-support.js") return { wslTaskFixtureBudgets }
      if (name === "vitest") return { it: { runIf: (required: boolean) => {
        expect(required).toBe(true)
        return (_name: string, _test: unknown, timeout: number) => registrations.push(timeout)
      } } }
      // All other imports are used only inside the uncalled native test.
      return {}
    },
  })
}

describe("WSL service fixture deadline", () => {
  it("keeps the default lifecycle and cleanup inside the runner's phase", () => {
    expect(wslTaskFixtureBudgets()).toEqual({ phase: 300_000, lifecycle: 240_000, diagnostics: 10_000, cleanup: 30_000, test: 281_000 })
  })

  it.each([180_000, 200_000, 350_000, 600_000])("derives both deadlines from a %i ms phase", (phase) => {
    const budget = wslTaskFixtureBudgets(String(phase))
    expect(budget.phase).toBe(phase)
    expect(budget.lifecycle).toBe(phase - 60_000)
    expect(budget.cleanup).toBe(30_000)
    expect(budget.diagnostics).toBe(10_000)
    expect(budget.test).toBe(budget.lifecycle + budget.diagnostics + budget.cleanup + 1_000)
    expect(budget.test).toBeLessThan(phase)
  })

  it.each(["", "NaN", "Infinity", "-1", "0", "4321", "179999", "600001", "200000.5", "2e5", " 200000"])(
    "refuses an invalid phase budget before any fixture is registered: %j", (phase) => {
      expect(() => wslTaskFixtureBudgets(phase)).toThrow("WSL service phase budget")
    },
  )

  it("uses the phase environment in the actual native test registration", () => {
    const registrations: number[] = []
    registerNativeProof("200000", registrations)
    expect(registrations).toEqual([181_000])
  })

  it("refuses an insufficient environment budget before registering the native test", () => {
    const registrations: number[] = []
    expect(() => registerNativeProof("4321", registrations)).toThrow("WSL service phase budget")
    expect(registrations).toEqual([])
  })
})
