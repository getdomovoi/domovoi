// The shared client still speaks WebSocket. Desktop supplies a worker-backed
// socket whose connect-src was authorized by main for one verified route.
export type ClientSocket = {
  readonly readyState: number
  // Set only by a local transport verifier, never copied from peer close text.
  readonly localAdmissionRefusal?: "relay-verification-refused" | undefined
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K, listener: (event: WebSocketEventMap[K]) => void, options?: AddEventListenerOptions,
  ): void
}
export type ClientSocketFactory = (url: string) => ClientSocket
