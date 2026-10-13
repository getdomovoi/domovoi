// Q363 A: a waiting gate always notifies, so approvalNeeded is not a choice.
// It stays in the record, always true, so a record an older build wrote and
// one this build writes have the same shape.
export type NotificationPreferences = {
  completion: boolean
  failure: boolean
  approvalNeeded: true
}

// The kinds a person can switch off.
export type NotificationPreferenceKey = "completion" | "failure"

const preferenceKeys: readonly NotificationPreferenceKey[] = ["completion", "failure"]

export function defaultNotificationPreferences(): NotificationPreferences {
  return { completion: true, failure: true, approvalNeeded: true }
}

// A stored approvalNeeded, false included, is ignored: an older build let a
// person switch approvals off, and that choice no longer exists.
export function parseNotificationPreferences(value: unknown): NotificationPreferences | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const parsed = defaultNotificationPreferences()
  for (const key of preferenceKeys) {
    const flag = record[key]
    if (typeof flag !== "boolean") return undefined
    parsed[key] = flag
  }
  return parsed
}

export function notificationPreferenceFor(
  preferences: NotificationPreferences,
  kind: "completion" | "failure" | "approval-needed",
): boolean {
  if (kind === "approval-needed") return true
  return preferences[kind]
}
