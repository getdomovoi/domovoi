import { expect, it } from "vitest"

import {
  defaultNotificationPreferences,
  notificationPreferenceFor,
  parseNotificationPreferences,
} from "./notification-preferences"

it("raises every notification kind until the client turns one off", () => {
  const preferences = defaultNotificationPreferences()

  expect(notificationPreferenceFor(preferences, "completion")).toBe(true)
  expect(notificationPreferenceFor(preferences, "failure")).toBe(true)
  expect(notificationPreferenceFor(preferences, "approval-needed")).toBe(true)
})

// Q363 A: a waiting gate always notifies. A preference saved by an older
// build that switched approvals off reads back as on, and the tracker kind
// is raised whatever the stored record says.
it("reads a stored approvals-off preference from an older build as on", () => {
  const stored = parseNotificationPreferences({ completion: false, failure: true, approvalNeeded: false })

  expect(stored).toEqual({ completion: false, failure: true, approvalNeeded: true })
  expect(notificationPreferenceFor(stored!, "approval-needed")).toBe(true)
  expect(notificationPreferenceFor(stored!, "completion")).toBe(false)
})

it("raises a waiting gate even when the record in memory says otherwise", () => {
  const forged = { ...defaultNotificationPreferences(), approvalNeeded: false } as unknown as ReturnType<typeof defaultNotificationPreferences>

  expect(notificationPreferenceFor(forged, "approval-needed")).toBe(true)
})

it("rejects a stored value that is missing or not boolean", () => {
  expect(parseNotificationPreferences(undefined)).toBeUndefined()
  expect(parseNotificationPreferences({ completion: true })).toBeUndefined()
  expect(parseNotificationPreferences({ completion: true, failure: "no", approvalNeeded: true })).toBeUndefined()
})

it("reads back a stored preference for every switchable kind", () => {
  expect(parseNotificationPreferences({ completion: false, failure: true })).toEqual({
    completion: false,
    failure: true,
    approvalNeeded: true,
  })
})
