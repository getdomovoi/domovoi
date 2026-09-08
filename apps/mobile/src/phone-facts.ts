export type PhoneFact = {
  label: string
  value: string
}

// The handoff lists what this phone is, as values rather than as links. None of
// them has anywhere to go, so none of them is drawn with a chevron.
//
// Every value is read rather than written down. The handoff's own values are
// fixture data: a phone that says it is an iPhone 15 Pro because the design
// said so is worse than one that says only what it can see.

// React Native reports the system version, not the hardware model, and reading
// the model needs a native module this app does not carry. What is reported is
// the platform this build is running on, which is true and is less than the
// handoff draws.
//
// The version arrives as a string on iOS and a number on Android, and as
// nothing at all where the platform does not report one. A version that cannot
// be read leaves the platform standing alone rather than being written out as
// the word undefined.
export type OsVersion = string | number | undefined | null

export function deviceLabel(os: string, osVersion: OsVersion): string {
  const platform = os === "ios" ? "iOS" : os === "android" ? "Android" : os
  const version = typeof osVersion === "number" ? String(osVersion) : (osVersion ?? "").trim()
  return version ? `${platform} ${version}` : platform
}

export function phoneFacts(input: {
  os: string
  osVersion: OsVersion
  // The same string the greeting sends the daemon, so the number on screen and
  // the number the machine has recorded cannot disagree.
  appVersion: string
}): PhoneFact[] {
  return [
    // Not a preference yet. The phone follows the desktop's dark theme and has
    // no light surface, so this states what is drawn rather than offering a
    // choice between two.
    { label: "Appearance", value: "Dark" },
    { label: "This device", value: deviceLabel(input.os, input.osVersion) },
    { label: "About", value: input.appVersion },
  ]
}
