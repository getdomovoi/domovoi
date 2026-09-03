import { previewBridgeChannelSchema, previewParentOriginSchema } from "@getdomovoi/protocol"
import { parse, type DefaultTreeAdapterTypes } from "parse5"

import { resolveAnnotationAnchor } from "./annotation-anchor-resolver.js"

function scriptLiteral(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c")
}

export function isSafePreviewSelector(selector: string): boolean {
  return selector.split(" > ").every((part) => (
    /^#[A-Za-z_][A-Za-z0-9_-]*$/.test(part)
    || /^[a-z][a-z0-9-]*(?::nth-of-type\([1-9][0-9]*\))?$/.test(part)
  ))
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
  const result = previewParentOriginSchema.safeParse(value)
  return result.success ? result.data : undefined
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
const MAX_ANCHORS=100;
const MAX_CANDIDATES=1500;
const MAX_TEXT_QUOTE=2000;
const resolveAnnotationAnchor=${resolveAnnotationAnchor.toString()};
const isSafePreviewSelector=${isSafePreviewSelector.toString()};
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
function textFor(element){return (element.innerText||element.textContent||"").replace(/\\s+/g," ").trim().slice(0,MAX_TEXT_QUOTE)}
function candidateFor(element){
  const rect=element.getBoundingClientRect();
  return {value:element,text:textFor(element),bbox:{x:rect.left,y:rect.top,width:rect.width,height:rect.height}};
}
function anchorCandidates(){
  const candidates=[];
  const root=document.body||document.documentElement;
  if(!root)return candidates;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT);
  let element=root;
  while(element&&candidates.length<MAX_CANDIDATES){
    if(element!==overlay){
      const candidate=candidateFor(element);
      if(candidate.bbox.width>0&&candidate.bbox.height>0)candidates.push(candidate);
    }
    element=walker.nextNode();
  }
  return candidates;
}
function validAnchor(anchor){
  if(!anchor||typeof anchor!=="object")return false;
  if(anchor.cssSelector!==undefined&&(typeof anchor.cssSelector!=="string"||anchor.cssSelector.length<1||anchor.cssSelector.length>1000))return false;
  if(anchor.textQuote!==undefined&&(typeof anchor.textQuote!=="string"||anchor.textQuote.length<1||anchor.textQuote.length>2000))return false;
  const bbox=anchor.bbox;
  if(bbox!==undefined&&(!bbox||typeof bbox!=="object"||![bbox.x,bbox.y,bbox.width,bbox.height].every(Number.isFinite)||bbox.x<0||bbox.y<0||bbox.width<=0||bbox.height<=0))return false;
  return Boolean(anchor.cssSelector||anchor.textQuote||bbox);
}
function resolveAnchors(message){
  if(message.artifactId!==artifactId||typeof message.requestId!=="string"||message.requestId.length<16||message.requestId.length>128||!Array.isArray(message.annotations)||message.annotations.length>MAX_ANCHORS)return;
  const candidates=anchorCandidates();
  const resolutions=message.annotations.map(function(item){
    if(!item||typeof item.annotationId!=="string"||item.annotationId.length<1||item.annotationId.length>256)return null;
    if(!validAnchor(item.anchor))return {annotationId:item.annotationId,status:"unresolved"};
    let selected;
    const safeSelector=item.anchor.cssSelector&&isSafePreviewSelector(item.anchor.cssSelector);
    if(safeSelector){
      try{
        const element=document.querySelector(item.anchor.cssSelector);
        if(element&&element!==overlay)selected=candidateFor(element);
      }catch{}
    }
    const result=resolveAnnotationAnchor(item.anchor,candidates,selected);
    return result.status==="resolved"
      ? {annotationId:item.annotationId,status:"resolved",strategy:result.strategy}
      : {annotationId:item.annotationId,status:"unresolved"};
  }).filter(Boolean);
  sendParent({type:"domovoi.preview.anchor-resolutions",channel:channel,artifactId:artifactId,requestId:message.requestId,resolutions:resolutions});
}
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
  setActive(false);
  sendParent({type:"domovoi.preview.selection",channel:channel,artifactId:artifactId,anchor:{cssSelector:selectorFor(element),...(text?{textQuote:text}:{}),bbox:{x:rect.left,y:rect.top,width:rect.width,height:rect.height}},label:element.tagName.toLowerCase()+(text?" · "+text.slice(0,80):"")});
}
function setActive(next){
  active=next;
  overlay.style.display="none";
  document.documentElement.style.cursor=active?"crosshair":"";
}
addEventListener("message",function(event){
  const message=event.data;
  if(event.source!==parent||event.origin!==parentOrigin||!message||message.channel!==channel)return;
  if(message.type==="domovoi.preview.picker"&&typeof message.active==="boolean")setActive(message.active);
  if(message.type==="domovoi.preview.resolve-anchors")resolveAnchors(message);
});
addEventListener("mouseover",hover,true);
addEventListener("click",select,true);
document.documentElement.appendChild(overlay);
sendParent({type:"domovoi.preview.ready",channel:channel,artifactId:artifactId});
})();</script>`

  const bodyClose = closingBodyOffset(content)
  return `${content.slice(0, bodyClose)}${script}${content.slice(bodyClose)}`
}
