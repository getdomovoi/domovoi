// The local daemon's socket on its default port. The vite dev server is not
// the daemon, so in development the page dials this unless told otherwise.
const localDaemonRpcUrl = "ws://127.0.0.1:47831/rpc"

// Where the page opens its socket. A page the daemon served shares the
// daemon's origin, so the socket is /rpc on the page's own host and port,
// over wss on https and ws on http (S3.2, docs/plans/s3-2-web-over-tailnet.md
// section 3.6). VITE_DOMOVOI_RPC_URL, set at build time, wins over both.
export function rpcUrlFor(input: {
  override: string | undefined
  dev: boolean
  location: { protocol: string; host: string }
}): string {
  if (input.override) return input.override
  if (input.dev) return localDaemonRpcUrl
  if (input.location.protocol === "https:") return `wss://${input.location.host}/rpc`
  if (input.location.protocol === "http:") return `ws://${input.location.host}/rpc`
  return localDaemonRpcUrl
}
