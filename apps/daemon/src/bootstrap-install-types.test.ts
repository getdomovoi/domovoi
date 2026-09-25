import { expectTypeOf, it } from "vitest"

import { install } from "./bootstrap-install.js"

// The installer returns where the runtime was installed. The declaration file
// is what the daemon is checked against, so it has to say so.
it("declares the runtime path the installer returns", () => {
  expectTypeOf<Awaited<ReturnType<typeof install>>>().toHaveProperty("runtimePath").toEqualTypeOf<string>()
})
