type LimitsStorage = Pick<Storage, "getItem" | "setItem">

const key = "domovoi.web.limitsSeen"

// Whether this tab has already been shown its limits. Read and written through
// the same storage the credential lives in; a browser that blocks it answers
// false both times, so the panel shows again and says why in its own rows.
export function browserLimitsSeen(storage: LimitsStorage): boolean {
  try {
    return storage.getItem(key) === "1"
  } catch {
    return false
  }
}

// Marks the tab and reports whether the mark took, which is whether the tab
// can hold anything at all.
export function markBrowserLimitsSeen(storage: LimitsStorage): boolean {
  try {
    storage.setItem(key, "1")
    return storage.getItem(key) === "1"
  } catch {
    return false
  }
}
