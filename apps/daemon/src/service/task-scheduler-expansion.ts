// Task Scheduler expands %NAME% in a task action's program and arguments each
// time the task runs, and substitutes $(Arg0) through $(Arg32) when the task
// runs with parameters. A value that contains either could run something
// other than what was checked, so it is refused before anything changes.
export class WindowsTaskPercentSignError extends Error {
  constructor(readonly path: string) {
    super(`${path} contains a percent sign, which Task Scheduler reads as an environment variable when the task runs. No service files were changed.`)
    this.name = "WindowsTaskPercentSignError"
  }
}

export class WindowsTaskArgumentVariableError extends Error {
  constructor(readonly path: string) {
    super(`${path} contains $(, which Task Scheduler reads as a task argument when the task runs. No service files were changed.`)
    this.name = "WindowsTaskArgumentVariableError"
  }
}

export function refuseTaskSchedulerExpansion(value: string): void {
  if (value.includes("%")) throw new WindowsTaskPercentSignError(value)
  if (value.includes("$(")) throw new WindowsTaskArgumentVariableError(value)
}
