# Alpha performance budgets

Domovoi uses deterministic limits for CI. Machine-dependent elapsed time and resident memory are
reported locally, not used as pass/fail thresholds. The canonical values live in
`performance-budgets.json`.

## Run

```bash
pnpm build
pnpm performance:budget
```

The command measures minified production artifact bytes for the web client and Electron renderer,
main process, and preload. It prints the measurements, budgets, and any failures as JSON. `pnpm
test` gates the runtime invariants below. CI runs both commands on Linux, macOS, and Windows.

For optional desktop timing and memory telemetry:

```bash
DOMOVOI_PERFORMANCE_REPORT=1 pnpm dev:desktop
```

One `domovoi.desktop.startup` JSON record reports app-ready, window-created, ready-to-show, and
daemon-ready milestones plus main-process RSS. Interpret it as local diagnostic evidence only.

## Budgets and gates

| Surface | Alpha budget | Stable gate |
| --- | --- | --- |
| Startup | Web JS 1,250,000 bytes; web CSS 115,000; desktop renderer JS 1,250,000; renderer CSS 115,000; main 32,768; preload 8,192 | Production artifact byte totals; desktop creates its hidden window before awaiting daemon startup and records bounded milestones |
| Memory | 100 thread items in a client snapshot; 200 retained history items; 262,144 terminal replay characters | Active-session snapshot window, bounded history merge/DOM, bounded terminal replay |
| Long threads | 100 snapshot/rendered items; 100 items per history page; 32,768 Markdown characters and 500 lines per item | Durable history remains daemon-owned and pageable; client and quick-view tests enforce windows |
| Terminal throughput | 65,536 characters per notification; 16 ms batching; WebSocket pause/resume at 1,048,576/262,144 buffered bytes | Fake-clock batching and backpressure tests plus protocol payload validation; bytes remain ordered and lossless |
| Large previews | 4,194,304 source bytes; 50,000 printable nodes; depth 64; 2 stages; 24 variants/thumbnails; 400,000 decoded thumbnail bytes | Bounded file-descriptor read at serve time, sanitizer limits, iframe/variant/cache invariants |

Budget failures require reducing work or an explicit documented budget revision. Do not replace
these gates with wall-clock or RSS assertions: CI runner speed and memory vary by OS and load.
