import type { JsonRpcMessage } from "./codex.js"

// Sanitized real codex-cli 0.162.1 app-server notifications against a local mock
// Responses endpoint, T127 captures. Hosted billing/remote compaction is not measured.
// IDs are mapped consistently; prompts, raw items, metadata and timestamps are removed.
// Notification order and usage counters are unchanged. SHA256 names the original capture.
export const codexUsageCaptures: Record<string, JsonRpcMessage[]> = {
  // multi-capture.json sha256 c36dad9594f48d8fa52e66cb6b6b548cca997c992d0d1be79535d286ea8f2c32
  "multi": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2","rootTurnId":"turn-2","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-2","responseId":"resp_3","usage":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":720,"inputTokens":600,"cachedInputTokens":60,"cacheWriteInputTokens":0,"outputTokens":120,"reasoningOutputTokens":30},"last":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","rootTurnId":"turn-2","status":"completed"}}},
  ],
  // overflow-capture.json sha256 235a4ad14bb32f22fa80b7a3f4730b3e3640cf30f6a73eee596293625ffb04de
  "overflow": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":258400,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"last":{"totalTokens":258040,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"modelContextWindow":258400}}},
    {"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":false,"error":{"codexErrorInfo":"contextWindowExceeded"}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"failed"}}},
  ],
  // interrupt-after-capture.json sha256 c7ba5a4f855d43bf446581ff143f810a5292f65fa87b6bbd763140e8c2bc0755
  "interrupt-after": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"interrupted"}}},
  ],
  // interrupt-before-capture.json sha256 943e98f6a90cfe272b0291749d817775f36a8ba26dcf61c8b6637e1138209786
  "interrupt-before": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"interrupted"}}},
  ],
  // interrupt-final-capture.json sha256 af1f62618a9543035fee1dfe80fcaac54d8cbbde2798cbfc64a5a3a06d804120
  "interrupt-final": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"interrupted"}}},
  ],
  // auto-capture.json sha256 14db529bb5c781f4bcf8b3b47bf628054f5e4fe335a530e067be157109e2a7e7
  "auto": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":3573,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"modelContextWindow":258400}}},
    {"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_3","usage":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":720,"inputTokens":600,"cachedInputTokens":60,"cacheWriteInputTokens":0,"outputTokens":120,"reasoningOutputTokens":30},"last":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // manual-capture.json sha256 20e2f8bef8e3be5ffc0c0296f48306404180aafbe230b257e6c57ee408fb9980
  "manual": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-2","rootTurnId":"turn-2","status":"inProgress"}}},
    {"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-2","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-2","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":3574,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"modelContextWindow":258400}}},
    {"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-2","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-2","rootTurnId":"turn-2","status":"completed"}}},
  ],
  // overflow-auto-capture.json sha256 aa7c9e38eade59c2d8894b3374dd9ee38e094c511744df32690a4476f96c9056
  "overflow-auto": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_3","usage":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":480,"inputTokens":400,"cachedInputTokens":40,"cacheWriteInputTokens":0,"outputTokens":80,"reasoningOutputTokens":20},"last":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":480,"inputTokens":400,"cachedInputTokens":40,"cacheWriteInputTokens":0,"outputTokens":80,"reasoningOutputTokens":20},"last":{"totalTokens":3575,"inputTokens":0,"cachedInputTokens":0,"cacheWriteInputTokens":0,"outputTokens":0,"reasoningOutputTokens":0},"modelContextWindow":258400}}},
    {"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"contextCompaction","id":"item-1"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_4","usage":{"totalTokens":480,"inputTokens":400,"cachedInputTokens":40,"cacheWriteInputTokens":0,"outputTokens":80,"reasoningOutputTokens":20}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":960,"inputTokens":800,"cachedInputTokens":80,"cacheWriteInputTokens":0,"outputTokens":160,"reasoningOutputTokens":40},"last":{"totalTokens":480,"inputTokens":400,"cachedInputTokens":40,"cacheWriteInputTokens":0,"outputTokens":80,"reasoningOutputTokens":20},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // missing-usage-capture.json sha256 a7df264d74e18c92c7fa30c3292fc5cbacbc527e132803db92434dce51e5c9c8
  "missing-usage": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":null}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // crash-capture.json sha256 ad17c6428cd9e3fb228cca89473cd91b9ddcf3d2ad1b892ffa7b0bd658510c89
  "crash": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"contextCompaction","id":"item-1"}}},
  ],
  // resume-capture.json sha256 71e8c715bb8d2bc2bba8542deef76e3d44926b89ef58f7e46e4a2fd9a1872156
  "resume": [
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":720,"inputTokens":600,"cachedInputTokens":60,"cacheWriteInputTokens":0,"outputTokens":120,"reasoningOutputTokens":30},"last":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"modelContextWindow":258400}}},
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":840,"inputTokens":700,"cachedInputTokens":70,"cacheWriteInputTokens":0,"outputTokens":140,"reasoningOutputTokens":35},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // resume-crash-capture.json sha256 f1bb84e8abd0a0c96de0968843c8d6ceabb2f1472c070eba500ce7054550c98c
  "resume-crash": [
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // stream-drop-capture.json sha256 06d161e606204aaaa133151df03dddff31a42f7b27d1c23a34b7546f2cfaa58e
  "stream-drop": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":true,"error":{"codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // failed-retry-capture.json sha256 fab7a7d8f9a307b7add28ee456f2132c62800ddfee1b1d66e85e6fcc3717e9dc
  "failed-retry": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"error","params":{"threadId":"thread-1","turnId":"turn-1","willRetry":true,"error":{"codexErrorInfo":{"responseStreamDisconnected":{"httpStatusCode":null}}}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // http-retry-capture.json sha256 0c53523a660e4499bf6785f97ca5f0de9834d33be792a2f7988c5efb4f086ae3
  "http-retry": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // subagent-capture.json sha256 caaf5e87b85558d0b560c6b9e734d491c9b08d2b9d1990c842aae8e8d0ef657a
  "subagent": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"item/started","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"collabAgentToolCall","tool":"spawnAgent","status":"inProgress","id":"item-1","receiverThreadIds":[]}}},
    {"method":"turn/started","params":{"threadId":"thread-2","turn":{"id":"turn-2","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"collabAgentToolCall","tool":"spawnAgent","status":"completed","id":"item-1","receiverThreadIds":["thread-2"]}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_2","usage":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-2","turnId":"turn-2","responseId":"resp_3","usage":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":240,"inputTokens":200,"cachedInputTokens":20,"cacheWriteInputTokens":0,"outputTokens":40,"reasoningOutputTokens":10},"modelContextWindow":258400}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-2","turnId":"turn-2","tokenUsage":{"total":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"last":{"totalTokens":360,"inputTokens":300,"cachedInputTokens":30,"cacheWriteInputTokens":0,"outputTokens":60,"reasoningOutputTokens":15},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
    {"method":"turn/completed","params":{"threadId":"thread-2","turn":{"id":"turn-2","rootTurnId":"turn-1","status":"completed"}}},
  ],
  // raw-optout-capture.json sha256 729cf132f6ef98068f04edef33acb3b625b4b83aa77ff1f7a7bbae59dee1f715
  "raw-optout": [
    {"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"inProgress"}}},
    {"method":"rawResponse/completed","params":{"threadId":"thread-1","turnId":"turn-1","responseId":"resp_1","usage":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5}}},
    {"method":"thread/tokenUsage/updated","params":{"threadId":"thread-1","turnId":"turn-1","tokenUsage":{"total":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"last":{"totalTokens":120,"inputTokens":100,"cachedInputTokens":10,"cacheWriteInputTokens":0,"outputTokens":20,"reasoningOutputTokens":5},"modelContextWindow":258400}}},
    {"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","rootTurnId":"turn-1","status":"completed"}}},
  ],
}
