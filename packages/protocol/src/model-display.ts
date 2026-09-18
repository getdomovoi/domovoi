// A model's display name is derived from its id and the harness that runs it,
// so a model that arrives from runtime.discover needs no second name written
// for it. The id remains the identifier: it is what the audit log and the
// provider's own error say, so the short form is shown beside it, never in
// place of it where the id is the only copy.
export function modelDisplayName(modelId: string, harnessId: string): string {
  const owned = new Set(harnessId.toLowerCase().split("-").filter(Boolean))
  const kept = modelId.split("-").filter((token) => !owned.has(token.toLowerCase()))
  return kept.length === 0 ? modelId : kept.join(" ")
}
