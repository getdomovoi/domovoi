import { OperationDeadline } from "./operation-deadline.js"

export type FlushedExitProcess = {
  stderr: { write(text: string, callback: () => void): unknown }
  exit(code: number): void
}

// A forced exit discards whatever a piped stderr has not drained, including
// the diagnostic that explains the exit. Wait for that write to leave the
// process, but only briefly: this path runs because a wait already failed.
export async function exitAfterStderr(
  text: string,
  code: number,
  budgetMs: number,
  target: FlushedExitProcess = process,
): Promise<void> {
  const deadline = OperationDeadline.start(budgetMs)
  try {
    await new Promise<void>((resolve) => {
      deadline.signal.addEventListener("abort", () => resolve(), { once: true })
      target.stderr.write(text, () => resolve())
    })
  } finally {
    deadline.clear()
    target.exit(code)
  }
}
