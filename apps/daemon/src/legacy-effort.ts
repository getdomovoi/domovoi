export function normalizeLegacyEffort(provider: string, reasoning: string): string {
  return (provider === "opencode" || provider === "kilo")
    && (reasoning === "medium" || reasoning === "none")
    ? "unset"
    : reasoning
}
