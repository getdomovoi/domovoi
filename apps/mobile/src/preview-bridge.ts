import { previewBridgeSelectionMessageSchema, type PreviewBridgeSelectionMessage } from "@getdomovoi/protocol"

// The daemon's preview bridge talks to `parent` with postMessage. In a frame
// on the desktop that is the app; in a WebView there is no parent, so
// `parent` is the page itself, and a listener injected beside the page
// forwards what the bridge says to the native side. The picker is switched
// the same way in reverse: the page is told to post to itself.
//
// The render is served under a sandbox without allow-same-origin, so its
// origin is opaque and reads as "null" on both ends. The grant therefore
// names "null" as the parent origin, the bridge posts to "*", and the
// picker message does the same; the channel is what matches them.

const channelAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"

// A channel is a match key, not a secret: it keeps a stale bridge from a
// previous render from being read as this one. Nothing else can post into a
// WebView the phone owns, so the platform's random is enough for it.
export function previewChannel(): string {
  let channel = ""
  for (let index = 0; index < 32; index += 1) {
    channel += channelAlphabet[Math.floor(Math.random() * channelAlphabet.length)]
  }
  return channel
}

export function webviewBridgeScript(channel: string): string {
  return `(function(){
var channel=${JSON.stringify(channel)};
window.addEventListener("message",function(event){
  var message=event.data;
  if(!message||message.channel!==channel||message.type!=="domovoi.preview.selection")return;
  if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(message));
});
})();true;`
}

export const previewParentOrigin = "null"

export function pickerScript(channel: string, active: boolean): string {
  const message = JSON.stringify({ type: "domovoi.preview.picker", channel, active })
  return `window.postMessage(${message},"*");true;`
}

export type PreviewSelection = { anchor: PreviewBridgeSelectionMessage["anchor"], label: string }

export function readSelection(data: string, channel: string, artifactId: string): PreviewSelection | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return undefined
  }
  const message = previewBridgeSelectionMessageSchema.safeParse(parsed)
  if (!message.success) return undefined
  if (message.data.channel !== channel || message.data.artifactId !== artifactId) return undefined
  return { anchor: message.data.anchor, label: message.data.label }
}
