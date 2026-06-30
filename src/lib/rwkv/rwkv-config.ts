// =============== 上游连接（禁止使用默认参数；env 未配置时为 undefined，由调用方显式校验） ===============

export const RWKV_ENDPOINT: string | undefined = process.env.RWKV_UPSTREAM_URL;

export const RWKV_API_PASSWORD: string | undefined =
  process.env.RWKV_UPSTREAM_PASSWORD;

// =============== 上游采样参数（全项目唯一来源，改参数只改这里） ===============

/**
 * 三轮生成对应三种上游调用。
 * - outlines：第一轮，POST /api/outlines。生成「世界观 + 章节大纲」长 JSON。
 * - chapters：第二轮，POST /api/chapters。按段落生成 80-120 字草稿。
 * - expand：  第三轮，POST /api/expand。把单段草稿扩写到 200-300 字。
 */
export type RwkvCallKind = "outlines" | "chapters" | "expand";

/**
 * 上游 /big_batch/completions 的采样参数。字段语义：
 * - maxTokens：单条 prompt 的最大生成 token 数。注意上游另有「输入+输出」组合预算 ~170k，
 *   rwkv-stream.ts 的 resolveMaxTokens 会按实际 prompt 大小再压一次。
 * - temperature：采样温度。值越大输出越发散；JSON 任务建议 ≤0.7。
 * - topK：截断到概率最高的 K 个 token，0 表示不截断（仅用 top_p）。
 * - topP：核采样阈值，仅在累计概率 ≤ topP 的 token 集合里采样。
 * - repetitionPenalty：重复惩罚。1.0 关闭；>1 抑制 token 复读；JSON 输出建议保持 1.0
 *   （会把 `{` `}` `"` 也罚下去，反而破坏结构）；散文输出可用 1.1-2.0。
 *   wire-format 字段名为 `repetition_penalty`。
 * - chunkSize：上游 SSE 推送的批量大小，越大延迟越高但吞吐越好；8 是稳定值。
 */
export interface RwkvSamplingParams {
  maxTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  repetitionPenalty: number;
  chunkSize: number;
}

export const RWKV_CALL_PARAMS: Record<RwkvCallKind, RwkvSamplingParams> = {
  // 第一轮：长 JSON 大纲。需要 ~5k 字符 + 多层嵌套，给足 max_tokens；
  // 温度调低，避免模型在 JSON 结构上发挥（错位的 `]` / 漏 `}` / 字符串内未转义 `\n`），
  // 风格多样性已由 prompt 层 OUTLINE_STYLES 提供，不靠采样去制造差异。
  // repetitionPenalty 必须保持 1.0：JSON 结构里 `{` `}` `"` `,` 高度重复，加惩罚会把结构罚崩。
  outlines: {
    maxTokens: 6000,
    temperature: 0.6,
    topK: 0,
    topP: 0.3,
    repetitionPenalty: 1.0,
    chunkSize: 8,
  },
  // 第二轮：单段草稿 80-120 字。max_tokens 400 足够，温度调高让叙事更有质感；
  // top_p 收紧避免人物/称谓漂移；repetitionPenalty=2 强力压制复读
  // （短段草稿最容易在结尾陷入「他笑了。他笑了。他笑了。」之类的循环）。
  chapters: {
    maxTokens: 400,
    temperature: 0.85,
    topK: 0,
    topP: 0.3,
    repetitionPenalty: 2,
    chunkSize: 8,
  },
  // 第三轮：扩写到 200-300 字。max_tokens 给到 600 留补写余地；
  // 其它参数与 chapters 一致——同样需要稳定的人物连续性与抗复读。
  expand: {
    maxTokens: 600,
    temperature: 0.85,
    topK: 0,
    topP: 0.3,
    repetitionPenalty: 2,
    chunkSize: 8,
  },
};

/**
 * 工作流路径 (`rwkv-batch-client.ts` → `novel-workflow.ts`) 的解码参数。
 * 与 RWKV_CALL_PARAMS 不同，这里使用上游 API 的原生字段名
 * (max_tokens / top_k / top_p / alpha_*)，并启用 presence / frequency / decay 惩罚。
 */
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
