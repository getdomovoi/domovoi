import performanceBudgetsJson from "../../../performance-budgets.json" with { type: "json" }

export const performanceBudgets = performanceBudgetsJson

export function performanceLimitsFor(budgets: typeof performanceBudgets) {
  const clientSnapshotThreadItems = budgets.memory.clientSnapshotThreadItems
  const renderedThreadItems = budgets.longThreads.renderedThreadItems
  return {
    clientSnapshotThreadItems,
    sessionHistoryPageItems: budgets.longThreads.historyPageItems,
    renderedThreadItems,
    effectiveClientThreadItems: Math.min(clientSnapshotThreadItems, renderedThreadItems),
    renderedPreviewStages: budgets.largePreviews.renderedStages,
  }
}

const performanceLimits = performanceLimitsFor(performanceBudgets)

export const maximumClientSnapshotThreadItems = performanceLimits.clientSnapshotThreadItems
export const maximumSessionHistoryPageItems = performanceLimits.sessionHistoryPageItems
export const maximumRenderedThreadItems = performanceLimits.renderedThreadItems
export const maximumEffectiveClientThreadItems = performanceLimits.effectiveClientThreadItems
export const maximumRenderedPreviewStages = performanceLimits.renderedPreviewStages
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
  if (items.length <= maximumEffectiveClientThreadItems) return [...items]
  if (!activeSessionId) return items.slice(-maximumEffectiveClientThreadItems)
  const activeIndexes: number[] = []
  const inactiveIndexes: number[] = []
  items.forEach((item, index) => {
    if (item.sessionId === activeSessionId) activeIndexes.push(index)
    else inactiveIndexes.push(index)
  })
  const selectedIndexes = new Set(activeIndexes.slice(-maximumEffectiveClientThreadItems))
  const remaining = maximumEffectiveClientThreadItems - selectedIndexes.size
  if (remaining > 0) {
    for (const index of inactiveIndexes.slice(-remaining)) selectedIndexes.add(index)
  }
  return items.filter((_item, index) => selectedIndexes.has(index))
}
