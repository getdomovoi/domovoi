export type NotificationPreferences = {
  completion: boolean
  failure: boolean
  approvalNeeded: boolean
}

export type NotificationPreferenceKey = keyof NotificationPreferences

const preferenceKeys: readonly NotificationPreferenceKey[] = ["completion", "failure", "approvalNeeded"]

export function defaultNotificationPreferences(): NotificationPreferences {
  return { completion: true, failure: true, approvalNeeded: true }
}

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
  if (kind === "approval-needed") return preferences.approvalNeeded
  return preferences[kind]
}
