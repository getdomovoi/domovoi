// Two 2,000,000-character Base64 uploads, the bounded prompt (including
// JSON escaping), and envelope/skill-selection overhead fit within 6 MiB.
export const maximumRpcMessageBytes = 6 * 1_024 * 1_024
