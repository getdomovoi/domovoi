export function wslTaskFixtureBudgets(phase?: string): {
  phase: number; lifecycle: number; cleanup: number; test: number
} {
  const text = phase ?? "300000"
  const milliseconds = Number(text)
  // Refuse before registering a task. Reserve cleanup and runner startup/
  // reporting time; a shorter outer phase must not kill Vitest's finally.
  // The minimum leaves 120 seconds for a lifecycle with a 60-second retry.
  if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(milliseconds)
    || milliseconds < 180_000 || milliseconds > 600_000) {
    throw new Error("WSL service phase budget must be an integer from 180000 through 600000 ms")
  }
  const cleanup = 30_000
  const lifecycle = milliseconds - cleanup - 30_000
  return { phase: milliseconds, lifecycle, cleanup, test: lifecycle + cleanup + 1_000 }
}
