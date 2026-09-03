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

it("maps the approval-needed tracker kind onto its stored preference", () => {
  const preferences = { ...defaultNotificationPreferences(), approvalNeeded: false }

  expect(notificationPreferenceFor(preferences, "approval-needed")).toBe(false)
  expect(notificationPreferenceFor(preferences, "failure")).toBe(true)
})

it("rejects a stored value that is missing or not boolean", () => {
  expect(parseNotificationPreferences(undefined)).toBeUndefined()
  expect(parseNotificationPreferences({ completion: true, failure: true })).toBeUndefined()
  expect(parseNotificationPreferences({ completion: true, failure: "no", approvalNeeded: true })).toBeUndefined()
})

it("reads back a stored preference for every kind", () => {
  expect(parseNotificationPreferences({ completion: false, failure: true, approvalNeeded: false })).toEqual({
    completion: false,
    failure: true,
    approvalNeeded: false,
  })
})
