// The shared client still speaks WebSocket. Desktop supplies a worker-backed
// socket whose connect-src was authorized by main for one verified route.
export type ClientSocket = {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener<K extends keyof WebSocketEventMap>(
    type: K, listener: (event: WebSocketEventMap[K]) => void, options?: AddEventListenerOptions,
  ): void
}
export type ClientSocketFactory = (url: string) => ClientSocket
