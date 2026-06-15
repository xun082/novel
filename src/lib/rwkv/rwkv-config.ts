export const RWKV_ENDPOINT =
  process.env.RWKV_ENDPOINT ??
  "http://47.115.88.183:1800/big_batch/completions";

export const RWKV_API_PASSWORD = process.env.RWKV_API_PASSWORD ?? "";

export const DEFAULT_RWKV_DECODE_CONFIG = {
  max_tokens: 1024,
  temperature: 0.8,
  top_k: 40,
  top_p: 0.9,
  alpha_presence: 0.3,
  alpha_frequency: 0.3,
  alpha_decay: 0.996,
};

export type RwkvDecodeConfig = typeof DEFAULT_RWKV_DECODE_CONFIG;

export function mergeDecodeConfig(
  override?: Partial<RwkvDecodeConfig>,
): RwkvDecodeConfig {
  return { ...DEFAULT_RWKV_DECODE_CONFIG, ...(override ?? {}) };
}

export function wrapJsonPrompt(userContent: string): string {
  return `User: ${userContent}
Assistant: \`\`\`json
`;
}
