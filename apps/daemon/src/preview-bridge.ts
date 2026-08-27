import { previewBridgeChannelSchema } from "@getdomovoi/protocol"
import { parse, type DefaultTreeAdapterTypes } from "parse5"

function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

function closingBodyOffset(content: string): number {
  const rawTextElements = new Set<string>([
    "iframe",
    "noembed",
    "noframes",
    "noscript",
    "script",
    "style",
    "textarea",
    "title",
    "xmp",
  ])
  const document = parse(content, { sourceCodeLocationInfo: true })

  const findElement = (
    node: DefaultTreeAdapterTypes.Node,
    name: string,
  ): DefaultTreeAdapterTypes.Element | undefined => {
    if ("tagName" in node && node.tagName === name) return node
    if (!("childNodes" in node)) return undefined
    for (const child of node.childNodes) {
      const found = findElement(child, name)
      if (found) return found
      if ("content" in child) {
        const inTemplate = findElement(child.content, name)
        if (inTemplate) return inTemplate
      }
    }
    return undefined
  }

  const firstBlockingElement = (
    node: DefaultTreeAdapterTypes.Node,
  ): DefaultTreeAdapterTypes.Element | undefined => {
    if (
      "tagName" in node
      && (node.tagName === "plaintext" || rawTextElements.has(node.tagName))
      && node.sourceCodeLocation?.startTag
      && !node.sourceCodeLocation.endTag
    ) return node
    if (!("childNodes" in node)) return undefined
    for (const child of node.childNodes) {
      const found = firstBlockingElement(child)
      if (found) return found
      if ("content" in child) {
        const inTemplate = firstBlockingElement(child.content)
        if (inTemplate) return inTemplate
      }
    }
    return undefined
  }

  const body = findElement(document, "body")
  const bodyClose = body?.sourceCodeLocation?.endTag?.startOffset
  if (bodyClose !== undefined) return bodyClose
  const blocking = body ? firstBlockingElement(body) : undefined
  return blocking?.sourceCodeLocation?.startTag?.startOffset ?? content.length
}

export function validPreviewBridgeChannel(value: string | null): string | undefined {
  const result = previewBridgeChannelSchema.safeParse(value)
  return result.success ? result.data : undefined
}

export function validPreviewParentOrigin(value: string | null): string | undefined {
  if (value === "null") return value
  if (!value) return undefined
  try {
    const url = new URL(value)
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== value) {
      return undefined
    }
    return url.origin
  } catch {
    return undefined
  }
}

export function injectPreviewBridge(
  content: string,
  artifactId: string,
  channel: string,
  parentOrigin: string,
): string {
  const script = `<script data-domovoi-preview-bridge>(function(){
const channel=${scriptLiteral(channel)};
const artifactId=${scriptLiteral(artifactId)};
const parentOrigin=${scriptLiteral(parentOrigin)};
let active=false;
const overlay=document.createElement("div");
overlay.setAttribute("aria-hidden","true");
Object.assign(overlay.style,{position:"fixed",display:"none",pointerEvents:"none",zIndex:"2147483647",border:"2px solid #f59e0b",background:"rgba(245,158,11,.12)",boxSizing:"border-box"});
function selectorFor(element){
  if(element===document.documentElement)return "html";
  if(element.id)return "#"+CSS.escape(element.id);
  const parts=[];
  let node=element;
  while(node&&node.nodeType===1&&node!==document.documentElement){
    let part=node.tagName.toLowerCase();
    const parentNode=node.parentElement;
    if(parentNode){
      const siblings=Array.from(parentNode.children).filter(function(child){return child.tagName===node.tagName});
      if(siblings.length>1)part+=":nth-of-type("+(siblings.indexOf(node)+1)+")";
    }
    parts.unshift(part);
    node=parentNode;
  }
  return parts.join(" > ");
}
function textFor(element){return (element.innerText||element.textContent||"").replace(/\\s+/g," ").trim().slice(0,280)}
function draw(element){
  const rect=element.getBoundingClientRect();
  Object.assign(overlay.style,{display:"block",left:rect.left+"px",top:rect.top+"px",width:rect.width+"px",height:rect.height+"px"});
}
function hover(event){if(active&&event.target instanceof Element&&event.target!==overlay)draw(event.target)}
function sendParent(message){parent.postMessage(message,parentOrigin==="null"?"*":parentOrigin)}
function select(event){
  if(!active||!(event.target instanceof Element)||event.target===overlay)return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const element=event.target;
  const rect=element.getBoundingClientRect();
  const text=textFor(element);
  sendParent({type:"domovoi.preview.selection",channel:channel,artifactId:artifactId,anchor:{cssSelector:selectorFor(element),...(text?{textQuote:text}:{}),bbox:{x:rect.left,y:rect.top,width:rect.width,height:rect.height}},label:element.tagName.toLowerCase()+(text?" · "+text.slice(0,80):"")});
}
function setActive(next){
  active=next;
  overlay.style.display="none";
  document.documentElement.style.cursor=active?"crosshair":"";
}
addEventListener("message",function(event){
  const message=event.data;
  if(event.source!==parent||event.origin!==parentOrigin||!message||message.type!=="domovoi.preview.picker"||message.channel!==channel||typeof message.active!=="boolean")return;
  setActive(message.active);
});
addEventListener("mouseover",hover,true);
addEventListener("click",select,true);
document.documentElement.appendChild(overlay);
sendParent({type:"domovoi.preview.ready",channel:channel,artifactId:artifactId});
})();</script>`

  const bodyClose = closingBodyOffset(content)
  return `${content.slice(0, bodyClose)}${script}${content.slice(bodyClose)}`
}
