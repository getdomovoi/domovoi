import { describe, expect, it } from "vitest"

import { isLoopbackHost } from "./transport-config.js"

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "localhost", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:127.255.255.255"])("counts %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(true)
  })

  // An IPv4-mapped address is loopback only inside 127.0.0.0/8. 7.240.0.1
  // maps to ::ffff:7f0:1, whose hex begins like 127's.
  it.each(["::ffff:7.240.0.1", "::ffff:7f0:1", "::ffff:128.0.0.1", "::ffff:126.255.255.255", "128.0.0.1", "100.80.185.103", "example.com"])("does not count %s as loopback", (host) => {
    expect(isLoopbackHost(host)).toBe(false)
  })
})
