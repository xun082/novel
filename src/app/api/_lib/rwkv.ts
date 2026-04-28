function mustEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

const UPSTREAM = mustEnv("RWKV_UPSTREAM_URL");
const DEFAULT_PASSWORD = mustEnv("RWKV_UPSTREAM_PASSWORD");
const DEFAULT_MAX_TOKENS = 2000;
/**
 * 上游 /big_batch/completions 的真正瓶颈：
 *
 *   1. **N (contents.length) 有硬上限，实测 ~120-130**。
 *      - N=120 + 44k 输入 + max_tokens=1000  ✅（实测一次 195KB 正常流式）
 *      - N=135 任意 max_tokens（含把 combined 压到 110k） ❌ 一律 200 + 空 body
 *      - N=150 任意 max_tokens                             ❌ 一律 200 + 空 body
 *      → 解决办法：客户端控制 prompt 总数 ≤ 120（见 page.tsx DEFAULT_CHAPTER_COUNT）。
 *
 *   2. combined = input_tokens + N × max_tokens 另外还有一个软上限（~170k）。
 *      但在 N ≤ 120 时几乎不会触及。
 *
 * 下面的 TOTAL_COMBINED_BUDGET 仅作为第二道保险——当真实场景确实需要很大
 * max_tokens（例如扩写）时再切入把 max_tokens 压低。
 */
const TOTAL_COMBINED_BUDGET = 170_000;
const MIN_TOKENS_PER_PROMPT = 300;
/**
 * 中文 prompt 的 char→token 近似系数（越小越保守）。
 * RWKV World tokenizer 对中文大致是 1 char ≈ 1 token，取 1.0 作为最坏情况估算。
 */
const CHARS_PER_TOKEN_ESTIMATE = 1.0;

function estimateInputTokens(contents: string[]): number {
  let totalChars = 0;
  for (const c of contents) totalChars += c.length;
  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

export const NO_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  Pragma: "no-cache",
  Expires: "0",
  "X-Accel-Buffering": "no",
} as const;

export interface UpstreamOptions {
  contents: string[];
  maxTokens?: number;
  temperature?: number;
  chunkSize?: number;
  stopTokens?: number[];
  password?: string;
}

function resolveMaxTokens(contents: string[], opts: UpstreamOptions): number {
  const requested = Math.max(
    1,
    Math.floor(opts.maxTokens ?? DEFAULT_MAX_TOKENS),
  );
  const n = Math.max(1, contents.length);
  const inputTokens = estimateInputTokens(contents);
  const outputBudget = Math.max(
    MIN_TOKENS_PER_PROMPT * n,
    TOTAL_COMBINED_BUDGET - inputTokens,
  );
  const perPromptBudget = Math.max(
    MIN_TOKENS_PER_PROMPT,
    Math.floor(outputBudget / n),
  );
  return Math.min(requested, perPromptBudget);
}

function buildUpstreamBody(contents: string[], opts: UpstreamOptions): string {
  const maxTokens = resolveMaxTokens(contents, opts);
  return JSON.stringify({
    contents,
    max_tokens: maxTokens,
    stop_tokens: opts.stopTokens ?? [0],
    temperature: opts.temperature ?? 0.9,
    chunk_size: opts.chunkSize ?? 8,
    stream: true,
    password: opts.password ?? DEFAULT_PASSWORD,
  });
}

const LOG_PROGRESS_INTERVAL_MS = 5000;

/**
 * 一次性把 opts.contents 全部送给上游 `/big_batch/completions`。
 * 上游的 contents 数组本身就是并发维度（数组长度 = 并发条数），
 * 因此无需在本层再做分批 / worker pool。
 *
 * 特点：
 *   - 逐 chunk passthrough（不做缓冲）。
 *   - 每 5 秒打印一次代理进度（chunks/bytes/ETA 首字节时间）。
 *   - 上游/下游任何一端断开，都会把另一端一起关掉，避免 ERR_INVALID_STATE 和算力浪费。
 */
export async function callUpstreamStream(opts: UpstreamOptions): Promise<Response> {
  const total = opts.contents.length;
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 8);
  const effectiveMaxTokens = resolveMaxTokens(opts.contents, opts);

  // 输入 prompt 规模统计（字符，用于粗略 token 估算：中文 ~1.5 char/token）
  let promptTotalChars = 0;
  let promptMin = Infinity;
  let promptMax = 0;
  for (const c of opts.contents) {
    promptTotalChars += c.length;
    if (c.length < promptMin) promptMin = c.length;
    if (c.length > promptMax) promptMax = c.length;
  }
  const promptAvg = Math.round(promptTotalChars / Math.max(1, total));
  const body = buildUpstreamBody(opts.contents, opts);
  const estInputTokens = estimateInputTokens(opts.contents);
  const estOutputTokens = total * effectiveMaxTokens;
  const estCombined = estInputTokens + estOutputTokens;

  console.log(
    `[rwkv:${requestId}] sending ${total} prompts (max_tokens=${effectiveMaxTokens}, est_output=${estOutputTokens}, est_input=${estInputTokens}, est_combined=${estCombined}/${TOTAL_COMBINED_BUDGET})`,
  );
  console.log(
    `[rwkv:${requestId}]   prompt_chars min/avg/max=${promptMin}/${promptAvg}/${promptMax} total_input_chars=${promptTotalChars} body_bytes=${body.length}`,
  );

  const abortController = new AbortController();

  let upstream: Response;
  try {
    upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body,
      cache: "no-store",
      signal: abortController.signal,
      // @ts-expect-error undici-specific：禁用响应体超时与长度上限
      duplex: "half",
    });
  } catch (err) {
    console.error(`[rwkv:${requestId}] upstream fetch failed`, err);
    return new Response(
      JSON.stringify({ error: (err as Error)?.message ?? "upstream fetch failed" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const allHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    allHeaders[k] = v;
  });
  console.log(
    `[rwkv:${requestId}] upstream status=${upstream.status} t=${Date.now() - startedAt}ms headers=${JSON.stringify(allHeaders)}`,
  );

  if (!upstream.ok || !upstream.body) {
    const text = upstream.body ? await upstream.text() : "";
    console.error(
      `[rwkv:${requestId}] upstream error`,
      upstream.status,
      text.slice(0, 600),
    );
    return new Response(text || `upstream ${upstream.status}`, {
      status: upstream.status || 502,
      headers: NO_CACHE_HEADERS,
    });
  }

  const upstreamBody = upstream.body;
  let downstreamCancelled = false;

  const passthrough = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      let chunks = 0;
      let bytes = 0;
      let firstByteAt: number | null = null;
      let lastReport = Date.now();

      const safeClose = () => {
        try {
          controller.close();
        } catch {
          // ignore double-close
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (downstreamCancelled) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            break;
          }
          if (firstByteAt === null) {
            firstByteAt = Date.now() - startedAt;
            console.log(
              `[rwkv:${requestId}] first chunk at ${firstByteAt}ms (${value.length}B)`,
            );
          }
          chunks += 1;
          bytes += value.length;
          try {
            controller.enqueue(value);
          } catch (err) {
            console.log(
              `[rwkv:${requestId}] downstream enqueue failed, stopping`,
              (err as Error)?.message,
            );
            downstreamCancelled = true;
            try {
              abortController.abort();
            } catch {
              // ignore
            }
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            break;
          }

          const now = Date.now();
          if (now - lastReport >= LOG_PROGRESS_INTERVAL_MS) {
            console.log(
              `[rwkv:${requestId}] streaming t+${((now - startedAt) / 1000).toFixed(
                1,
              )}s chunks=${chunks} bytes=${bytes}`,
            );
            lastReport = now;
          }
        }
        const ms = Date.now() - startedAt;
        console.log(
          `[rwkv:${requestId}] upstream closed: chunks=${chunks} bytes=${bytes} total=${(ms / 1000).toFixed(1)}s`,
        );
        if (chunks === 0 && bytes === 0 && !downstreamCancelled) {
          console.error(
            `[rwkv:${requestId}] ⚠️ upstream returned status=200 but EMPTY body. 通常是：input_tokens+output_tokens 超上游额度 / 上游过载。`,
          );
          try {
            const fs = await import("node:fs");
            const path = `/tmp/rwkv-empty-${requestId}-${Date.now()}.json`;
            fs.writeFileSync(path, body);
            console.error(
              `[rwkv:${requestId}] 已保存失败请求体到 ${path}，可用脚本重放复现：`,
            );
            console.error(
              `[rwkv:${requestId}]   curl -sS -X POST '${UPSTREAM}' -H 'Content-Type: application/json' --data @${path} -N | head`,
            );
          } catch (e) {
            console.error(`[rwkv:${requestId}] dump body failed`, e);
          }
        }
        safeClose();
      } catch (err) {
        const e = err as { name?: string; code?: string; message?: string };
        const aborted = e?.name === "AbortError" || downstreamCancelled;
        const ms = Date.now() - startedAt;
        if (aborted) {
          console.log(
            `[rwkv:${requestId}] upstream aborted after ${(ms / 1000).toFixed(1)}s (chunks=${chunks} bytes=${bytes})`,
          );
        } else {
          console.error(
            `[rwkv:${requestId}] upstream stream error after ${(ms / 1000).toFixed(1)}s (chunks=${chunks} bytes=${bytes})`,
            e?.code ?? "",
            e?.message ?? err,
          );
        }
        safeClose();
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore
        }
      }
    },
    cancel(reason) {
      downstreamCancelled = true;
      console.log(
        `[rwkv:${requestId}] downstream cancelled after ${(
          (Date.now() - startedAt) /
          1000
        ).toFixed(1)}s`,
        reason,
      );
      try {
        abortController.abort();
      } catch {
        // ignore
      }
    },
  });

  return new Response(passthrough, {
    status: upstream.status,
    headers: {
      "Content-Type":
        upstream.headers.get("Content-Type") ?? "text/event-stream",
      ...NO_CACHE_HEADERS,
    },
  });
}

// =============== Prompt builders ===============

const OUTLINE_STYLES = [
  "热血冒险",
  "权谋智斗",
  "情感细腻",
  "悬疑推理",
  "轻松幽默",
  "暗黑系",
  "温馨治愈",
  "史诗宏大",
];

export function buildOutlinePrompts(
  genre: string,
  chapters: number,
  count: number,
): string[] {
  const jsonExample = `{
  "title": "小说标题",
  "summary": "核心梗概（100-200字）",
  "chapters": [
    {"chapter": "第一章", "title": "章节标题", "outline": "内容梗概（50-100字）"},
    {"chapter": "第二章", "title": "章节标题", "outline": "内容梗概（50-100字）"}
  ]
}`;

  return Array.from({ length: count }, (_, index) => {
    const style = OUTLINE_STYLES[index % OUTLINE_STYLES.length];
    const batchNo = Math.floor(index / OUTLINE_STYLES.length) + 1;
    const differentiation =
      batchNo > 1
        ? `补充要求：与同风格方案保持显著差异，重点突出第${batchNo}套创意路线。`
        : "";

    return `User: 写一份[${genre}]小说大纲，共${chapters}章。要求风格：${style}。

请以JSON格式输出，格式如下：
${jsonExample}

要求：
1. title要有吸引力
2. summary要详细（100-200字）
3. chapters数组包含${chapters}个章节
4. 每章outline要详细（50-100字）
5. 保持整体节奏统一，主线清晰

${differentiation ? `${differentiation}\n` : ""}

直接输出JSON，不要其他说明。\n\nAssistant: <think>\n</think>\n\`\`\`json\n`;
  });
}

export interface ChapterTaskInput {
  novelContext: { title: string; summary: string };
  chapter: { title: string; outline: string };
  /** 仅保留作兼容字段，不再写入 prompt（上游已按 contents[] 下标自动对齐 index） */
  chapterOrder?: number;
  chapterTotal?: number;
}

/**
 * 极简章节 prompt —— 只保留模型真正需要的信息：
 * 小说标题、整体梗概、本章标题、本章梗概，以及 600-800 字 + JSON 输出约束。
 * 其余样板（⚠️ 核心要求 / 写作任务 / 格式要求…）全部删掉，避免 N 条 × 重复废话
 * 把上游的 input token 额度撑爆。
 */
export function buildChapterPrompts(tasks: ChapterTaskInput[]): string[] {
  return tasks.map(
    ({ novelContext, chapter }) =>
      `User: 写小说《${novelContext.title}》的一章正文，600-800字，仅输出 JSON：{"content":"..."}。
整体梗概：${novelContext.summary}
本章：${chapter.title} —— ${chapter.outline}\n\nAssistant: \`\`\`json\n`,
  );
}

export interface ExpandTaskInput {
  title: string;
  outline: string;
  currentContent: string;
}

export function buildExpandPrompts(tasks: ExpandTaskInput[]): string[] {
  return tasks.map(
    ({ title, outline, currentContent }) =>
      `User: 扩写下面这章到 700-900 字，贴合梗概，仅输出 JSON：{"content":"..."}。
章节：${title} —— ${outline}
原文：${currentContent}\n\nAssistant: \`\`\`json\n`,
  );
}
