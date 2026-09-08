import { describe, expect, it } from "vitest"

import { deviceLabel, phoneFacts } from "./phone-facts"

describe("deviceLabel", () => {
  it("names the platform the way the platform is written, not the way it is keyed", () => {
    expect(deviceLabel("ios", "18.2")).toBe("iOS 18.2")
    expect(deviceLabel("android", "15")).toBe("Android 15")
  })

  it("takes the number Android reports as readily as the string iOS reports", () => {
    expect(deviceLabel("android", 35)).toBe("Android 35")
  })

  // A platform that reports no version must leave the row saying less, not
  // saying the word undefined out loud.
  it("says only the platform when no version was reported", () => {
    expect(deviceLabel("ios", "")).toBe("iOS")
    expect(deviceLabel("ios", "   ")).toBe("iOS")
    expect(deviceLabel("ios", undefined)).toBe("iOS")
    expect(deviceLabel("ios", null)).toBe("iOS")
  })

  // Inventing a friendly name for a platform this build has never run on would
  // be a guess printed as a fact.
  it("repeats an unknown platform rather than naming it", () => {
    expect(deviceLabel("web", "5")).toBe("web 5")
  })
})

describe("phoneFacts", () => {
  const facts = () => phoneFacts({ os: "ios", osVersion: "18.2", appVersion: "1.2.3" })

  it("reports the version it was given rather than one written down here", () => {
    expect(facts().find((fact) => fact.label === "About")?.value).toBe("1.2.3")
    expect(phoneFacts({ os: "ios", osVersion: "18.2", appVersion: "9.9.9" })
      .find((fact) => fact.label === "About")?.value).toBe("9.9.9")
  })

  it("reports the device it was given rather than one written down here", () => {
    expect(facts().find((fact) => fact.label === "This device")?.value).toBe("iOS 18.2")
    expect(phoneFacts({ os: "android", osVersion: "15", appVersion: "1.2.3" })
      .find((fact) => fact.label === "This device")?.value).toBe("Android 15")
  })

  // The phone has one theme and no switch for it, so the row states what is
  // drawn. It stops being true the day a light surface lands.
  it("states the one appearance this build has", () => {
    expect(facts().find((fact) => fact.label === "Appearance")?.value).toBe("Dark")
  })

  // There is no notification code, no permission request and no stored
  // preference, so there is no effective behaviour to report.
  it("claims nothing about notifications", () => {
    expect(facts().map((fact) => fact.label)).not.toContain("Notifications")
  })

  it("carries a value for every row it lists", () => {
    for (const fact of facts()) expect(fact.value).not.toBe("")
  })
})
