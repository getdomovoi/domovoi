// NativeWind resolves conflicting classes in order, so joining is enough and a
// merge helper would only add a dependency that hides that.
export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ")
}
