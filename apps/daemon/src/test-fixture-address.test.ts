import { expect, it } from "vitest"

import { fixtureAddress } from "./test-fixture-address.js"

const line = '{"url":"ws://127.0.0.1:4173/rpc"}\n'

it("reports a split chunk as not ready instead of failing to parse it", () => {
  for (const partial of ['{"url":', line.slice(0, -1)]) {
    expect(() => fixtureAddress(partial)).toThrow(/has not printed its address yet/)
  }
})

it("parses the first complete line and ignores anything after it", () => {
  expect(fixtureAddress(line)).toEqual({ url: "ws://127.0.0.1:4173/rpc" })
  expect(fixtureAddress(`${line}domovoid credential stored at /tmp/x\n`)).toEqual({ url: "ws://127.0.0.1:4173/rpc" })
})

it("refuses a complete line that names no url", () => {
  expect(() => fixtureAddress('{"listening":true}\n')).toThrow(/printed no url/)
})
