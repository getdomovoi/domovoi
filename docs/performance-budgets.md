# Alpha performance budgets

Domovoi uses deterministic limits for CI. Machine-dependent elapsed time and resident memory are
reported locally, not used as pass/fail thresholds. The canonical values live in
`performance-budgets.json`.

## Run

```bash
pnpm build
pnpm performance:budget
```

The command measures minified production bytes for the web client and Electron renderer, main
process, and preload. Startup JavaScript counts only the graph the built `index.html` loads
eagerly: the entry module and every `modulepreload` it declares. Chunks that load lazily, such as
the terminal pane and the Settings, Skills, Machines and Audit log surfaces, are paid for only when
that surface opens, so each lazy chunk is held to the lazy budget on its own, together with every
chunk it imports that startup did not already load: the reported lazy bytes are the largest such
graph, not the sum of all lazy chunks. An eager regression and an oversized lazy chunk
both fail the gate. It prints the measurements, budgets, and any failures
as JSON. `pnpm test` gates the runtime invariants below. CI runs both commands on Linux, macOS,
and Windows.

For optional desktop timing and memory telemetry:

```bash
DOMOVOI_PERFORMANCE_REPORT=1 pnpm dev:desktop
```

One `domovoi.desktop.startup` JSON record reports app-ready, window-created, ready-to-show, and
daemon-ready milestones plus main-process RSS. Interpret it as local diagnostic evidence only.

## Budgets and gates

| Surface | Alpha budget | Stable gate |
| --- | --- | --- |
| Startup | Web JS 1,250,000 startup bytes and 400,000 lazy bytes; web CSS 124,000; desktop renderer JS 1,250,000 startup bytes and 400,000 lazy bytes; renderer CSS 124,000; main 39,936; preload 9,728 | Startup graph measured from the built `index.html` entry and `modulepreload` links, lazy chunks reported separately; desktop creates its hidden window before awaiting daemon startup and records bounded milestones |
| Memory | 100 thread items in a client snapshot; 200 retained history items; 65,536 terminal replay characters | Active-session snapshot window, bounded history merge/DOM, bounded terminal replay |
| Long threads | 100 snapshot/rendered items; 100 items per history page; 32,768 Markdown characters and 500 lines per item | Durable history remains daemon-owned and pageable; client and quick-view tests enforce windows |
| Terminal throughput | 65,536 characters per notification; 16 ms batching; WebSocket pause/resume at 1,048,576/262,144 buffered bytes | Fake-clock batching and backpressure tests plus protocol payload validation; bytes remain ordered and lossless |
| Large previews | 4,194,304 source bytes; 50,000 printable nodes; depth 64; 2 stages; 24 variants/thumbnails; 400,000 decoded thumbnail bytes | Bounded file-descriptor read at serve time, sanitizer limits, iframe/variant/cache invariants |

The CSS budgets were 115,000 until 2026-09-08, when the v2 design set's token contract took the
web sheet to 115,147. The added bytes are the `--ok-*` state ramp and the `--skel` pair, which the
v2 screens read, in both themes. Raised to 124,000 rather than trimmed, because the remaining v2
screens add more utility classes and a ceiling that fails on the next screen teaches nothing. If a
measurement approaches it again, check what is unused before raising it further.

The desktop main budget was 33,792 until 2026-09-14, when the relay pin file took the main bundle
to 35,813 bytes locally and 35,397 on CI. The added bytes are the file's shape validation, the
synced whole-file publication and the compare-and-swap the renderer reaches over one IPC channel.
Raised to 36,864 rather than trimmed: the validation and the sync are the finding they answer, and
the main process has no lazy path to move them to.

It was 36,864 until 2026-09-23. Credential capture as the first import of the main entry
(2ad6561a) raised it to 37,888. About this build adds the IPC handler that opens the release page
and the fixed release-page URL, kept in main so the renderer names no address; with both, the main
bundle measures 37,274 bytes locally. The owner had ruled a raise to 37,376 for About alone rather
than a trim that rewrote the IPC authorization guards, which stay as they are; the later raise to
37,888 covers it.

It was 37,888, and the preload budget 8,192, until 2026-09-26. The login service from Settings
(#576) adds to both. Its code (the service calls, the runtime copy and the handoff) loads with a
lazy `import()` when Settings first asks, which saved 11,159 bytes from the main bundle. What stays
at startup is the handoff hold a renderer reconnect needs at any time, the three service IPC
handlers with their authorization checks, and the loader: the main bundle measures 39,176 bytes.
The preload is one sandboxed bundle with no lazy path, and it keeps its checks on the service's
answers: it measures 9,417 bytes. The owner ruled on 2026-09-26 to raise main to 39,936 and preload
to 9,728, keeping the lazy import and the validation in the preload.

Budget failures require reducing work or an explicit documented budget revision. Do not replace
these gates with wall-clock or RSS assertions: CI runner speed and memory vary by OS and load.
