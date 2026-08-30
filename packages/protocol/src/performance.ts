import performanceBudgetsJson from "../../../performance-budgets.json" with { type: "json" }

export const performanceBudgets = performanceBudgetsJson
export const maximumClientSnapshotThreadItems = performanceBudgets.memory.clientSnapshotThreadItems
export const maximumRetainedSessionHistoryItems = performanceBudgets.memory.sessionHistoryRetainedItems
export const maximumTerminalReplayCharacters = performanceBudgets.memory.terminalReplayCharacters
export const maximumTerminalOutputChunkCharacters = performanceBudgets.terminalThroughput.outputChunkCharacters
export const terminalOutputBatchDelayMilliseconds = performanceBudgets.terminalThroughput.batchDelayMilliseconds
export const terminalWebSocketHighWaterBytes = performanceBudgets.terminalThroughput.websocketHighWaterBytes
export const terminalWebSocketLowWaterBytes = performanceBudgets.terminalThroughput.websocketLowWaterBytes
export const maximumPreviewSourceBytes = performanceBudgets.largePreviews.sourceBytes

export function boundedClientThread<T extends { sessionId: string }>(
  items: readonly T[],
  activeSessionId: string | null,
): T[] {
  if (items.length <= maximumClientSnapshotThreadItems) return [...items]
  if (!activeSessionId) return items.slice(-maximumClientSnapshotThreadItems)
  const activeIndexes: number[] = []
  const inactiveIndexes: number[] = []
  items.forEach((item, index) => {
    if (item.sessionId === activeSessionId) activeIndexes.push(index)
    else inactiveIndexes.push(index)
  })
  const selectedIndexes = new Set(activeIndexes.slice(-maximumClientSnapshotThreadItems))
  const remaining = maximumClientSnapshotThreadItems - selectedIndexes.size
  if (remaining > 0) {
    for (const index of inactiveIndexes.slice(-remaining)) selectedIndexes.add(index)
  }
  return items.filter((_item, index) => selectedIndexes.has(index))
}
