export async function settleTerminalWrite<T>(
  request: Promise<void>,
  terminal: T,
  currentTerminal: () => T | null,
  onSuccess: () => void,
  onError: (cause: unknown) => void,
): Promise<void> {
  try {
    await request
    if (currentTerminal() === terminal) onSuccess()
  } catch (cause: unknown) {
    if (currentTerminal() === terminal) onError(cause)
  }
}
