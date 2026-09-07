// One worker, one socket. Main admits this worker's exact connect-src before
// this source runs. No bearer is carried in the worker URL or retained on disk.
let socket
self.onmessage = ({ data }) => {
  if (data.type === "open" && !socket) {
    socket = new WebSocket(data.url)
    socket.onopen = () => self.postMessage({ type: "open" })
    socket.onmessage = (event) => self.postMessage({ type: "message", data: event.data })
    socket.onerror = () => self.postMessage({ type: "error" })
    socket.onclose = (event) => self.postMessage({ type: "close", code: event.code })
  } else if (data.type === "send" && socket?.readyState === WebSocket.OPEN) {
    socket.send(data.data)
  } else if (data.type === "close") {
    socket?.close()
    self.close()
  }
}
