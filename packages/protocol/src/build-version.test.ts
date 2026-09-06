import { expect, it, vi } from "vitest"

import * as protocol from "./index.js"

// Simulate a release, not two independent literals agreeing at today's version.
vi.mock("../package.json", () => ({ version: "9.8.7-test", default: { version: "9.8.7-test" } }))

it("derives the runtime build identity from release metadata, not the wire version", () => {
  expect(Reflect.get(protocol, "buildVersion")).toBe("9.8.7-test")
  expect(protocol.protocolVersion).not.toBe("9.8.7-test")
})
