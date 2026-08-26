const { DomovoiDaemon } = await import("./dist/server.js")

const daemon = new DomovoiDaemon({ statePath: ":memory:" })
await daemon.stop()
