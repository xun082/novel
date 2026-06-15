import * as fs from "node:fs";
import * as path from "node:path";
import {
  rwkvResolvedUrlSchema,
  upstreamStreamRequestSchema,
} from "./rwkv-schema";

// =============== 调试 dump：每次请求把上游原始流落盘 ===============

/** 关掉后所有 dump 行为都消失（影响 0），打开后写到 <repo>/.rwkv-dumps/ */
const DUMP_ENABLED = process.env.RWKV_DUMP_DISABLED !== "1";
const DUMP_DIR = path.join(process.cwd(), ".rwkv-dumps");

interface DumpHandle {
  kind: RwkvCallKind;
  requestId: string;
  startedAt: number;
  rawPath: string;
  metaPath: string;
  rawStream: fs.WriteStream | null;
  chunks: number;
  bytes: number;
}

function openDump(
  kind: RwkvCallKind,
  requestId: string,
  startedAt: number,
  meta: Record<string, unknown>,
): DumpHandle {
  const handle: DumpHandle = {
    kind,
    requestId,
    startedAt,
    rawPath: "",
    metaPath: "",
    rawStream: null,
    chunks: 0,
    bytes: 0,
  };
  if (!DUMP_ENABLED) return handle;
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const ts = new Date(startedAt)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "");
    const base = `${kind}-${ts}-${requestId}`;
    handle.rawPath = path.join(DUMP_DIR, `${base}.raw.txt`);
    handle.metaPath = path.join(DUMP_DIR, `${base}.meta.json`);
    handle.rawStream = fs.createWriteStream(handle.rawPath, { flags: "w" });
    fs.writeFileSync(
      handle.metaPath,
      JSON.stringify({ phase: "start", ...meta }, null, 2),
    );
    console.log(`[rwkv:${requestId}] dump → ${handle.rawPath}`);
  } catch (e) {
    console.error(`[rwkv:${requestId}] dump open failed`, e);
    handle.rawStream = null;
  }
  return handle;
}

function dumpChunk(handle: DumpHandle, value: Uint8Array): void {
  if (!handle.rawStream) return;
  handle.chunks += 1;
  handle.bytes += value.length;
  try {
    handle.rawStream.write(Buffer.from(value));
  } catch (e) {
    console.error(`[rwkv:${handle.requestId}] dump write failed`, e);
  }
}

function closeDump(
  handle: DumpHandle,
  finalMeta: Record<string, unknown>,
): void {
  if (!handle.rawStream) return;
  try {
    handle.rawStream.end();
  } catch {
    // ignore
  }
  try {
    fs.writeFileSync(
      handle.metaPath,
      JSON.stringify(
        {
          phase: "end",
          chunks: handle.chunks,
          bytes: handle.bytes,
          durationMs: Date.now() - handle.startedAt,
          ...finalMeta,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(`[rwkv:${handle.requestId}] dump close failed`, e);
  }
}

/** 环境变量默认；请求级覆盖经 zod 校验后优先 */
const DEFAULT_UPSTREAM_URL = process.env.RWKV_UPSTREAM_URL ?? "";
const DEFAULT_UPSTREAM_PASSWORD = process.env.RWKV_UPSTREAM_PASSWORD ?? "";

// =============== 上游采样参数（只改这里） ===============

export type RwkvCallKind = "outlines" | "chapters" | "expand";

export interface RwkvSamplingParams {
  maxTokens: number;
  temperature: number;
  topK: number;
  topP: number;
  chunkSize: number;
}

/**
 * 各接口上游采样与生成参数。
 * 禁止在调用处用 ?? 兜底；改参数只改此表。
 */
export const RWKV_CALL_PARAMS: Record<RwkvCallKind, RwkvSamplingParams> = {
  outlines: {
    maxTokens: 6000,
    // 大纲是长 JSON（~5k 字符、多层嵌套），温度过高时模型容易：
    //   - 提前闭合 "chapters": [...]，后续章节变成游离对象；
    //   - 陷入闭合大括号死循环吃满 max_tokens；
    //   - 在字符串里漏一个未转义的 \n。
    // 风格多样性已经由 OUTLINE_STYLES 在 prompt 层做了，
    // 这里不需要靠采样温度去制造差异。0.6 是稳态 JSON 的甜点。
    temperature: 0.6,
    topK: 0,
    topP: 0.3,
    chunkSize: 8,
  },
  chapters: {
    maxTokens: 400,
    temperature: 0.85,
    topK: 0,
    topP: 0.3,
    chunkSize: 8,
  },
  expand: {
    maxTokens: 600,
    temperature: 0.85,
    topK: 0,
    topP: 0.3,
    chunkSize: 8,
  },
};
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

export interface UpstreamStreamRequest {
  contents: string[];
  /** 请求级覆盖，优先于 RWKV_UPSTREAM_PASSWORD */
  password?: string;
  /** 请求级覆盖，优先于 RWKV_UPSTREAM_URL */
  upstreamUrl?: string;
}

interface UpstreamBodyParams extends RwkvSamplingParams {
  contents: string[];
}

/** 从 POST JSON 根级读取可选上游覆盖（与 {@link UpstreamStreamRequest} 同名，由 zod 在 callUpstreamStream 内校验） */
export function upstreamCredentialsFromPayload(
  payload: Record<string, unknown>,
): Pick<UpstreamStreamRequest, "upstreamUrl" | "password"> {
  const o: Pick<UpstreamStreamRequest, "upstreamUrl" | "password"> = {};
  if (typeof payload.upstreamUrl === "string" && payload.upstreamUrl !== "")
    o.upstreamUrl = payload.upstreamUrl;
  if (typeof payload.password === "string" && payload.password !== "")
    o.password = payload.password;
  return o;
}

function resolveMaxTokens(contents: string[], maxTokens: number): number {
  const requested = Math.max(1, Math.floor(maxTokens));
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

function buildUpstreamBody(
  params: UpstreamBodyParams,
  password: string | undefined,
): string {
  const maxTokens = resolveMaxTokens(params.contents, params.maxTokens);
  const body: Record<string, unknown> = {
    contents: params.contents,
    max_tokens: maxTokens,
    temperature: params.temperature,
    top_k: params.topK,
    top_p: params.topP,
    chunk_size: params.chunkSize,
    stream: true,
  };
  if (password !== undefined && password !== "") {
    body.password = password;
  }
  return JSON.stringify(body);
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
export async function callUpstreamStream(
  kind: RwkvCallKind,
  opts: UpstreamStreamRequest,
): Promise<Response> {
  const parsedOpts = upstreamStreamRequestSchema.safeParse(opts);
  if (!parsedOpts.success) {
    return new Response(
      JSON.stringify({
        error: "invalid_upstream_options",
        issues: parsedOpts.error.issues,
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const v = parsedOpts.data;
  const sampling = RWKV_CALL_PARAMS[kind];
  const url = v.upstreamUrl ?? DEFAULT_UPSTREAM_URL;
  const passwordRaw = v.password ?? DEFAULT_UPSTREAM_PASSWORD;
  const fetchPassword =
    typeof passwordRaw === "string" && passwordRaw.length > 0 ? passwordRaw : undefined;

  const urlResolved = rwkvResolvedUrlSchema.safeParse({ url });
  if (!urlResolved.success) {
    return new Response(
      JSON.stringify({
        error: "invalid_upstream_credentials",
        issues: urlResolved.error.issues,
      }),
      {
        status: 503,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const { url: fetchUrl } = urlResolved.data;

  const bodyParams: UpstreamBodyParams = {
    contents: v.contents,
    ...sampling,
  };

  const total = v.contents.length;
  const startedAt = Date.now();
  const requestId = Math.random().toString(36).slice(2, 8);
  const effectiveMaxTokens = resolveMaxTokens(v.contents, sampling.maxTokens);

  // 输入 prompt 规模统计（字符，用于粗略 token 估算：中文 ~1.5 char/token）
  let promptTotalChars = 0;
  let promptMin = Infinity;
  let promptMax = 0;
  for (const c of v.contents) {
    promptTotalChars += c.length;
    if (c.length < promptMin) promptMin = c.length;
    if (c.length > promptMax) promptMax = c.length;
  }
  const promptAvg = Math.round(promptTotalChars / Math.max(1, total));
  const body = buildUpstreamBody(bodyParams, fetchPassword);
  const estInputTokens = estimateInputTokens(v.contents);
  const estOutputTokens = total * effectiveMaxTokens;
  const estCombined = estInputTokens + estOutputTokens;

  console.log(
    `[rwkv:${requestId}] POST ${fetchUrl}`,
  );
  console.log(
    `[rwkv:${requestId}] sending ${total} prompts (max_tokens=${effectiveMaxTokens}, est_output=${estOutputTokens}, est_input=${estInputTokens}, est_combined=${estCombined}/${TOTAL_COMBINED_BUDGET})`,
  );
  console.log(
    `[rwkv:${requestId}]   prompt_chars min/avg/max=${promptMin}/${promptAvg}/${promptMax} total_input_chars=${promptTotalChars} body_bytes=${body.length}`,
  );
  console.log(
    `[rwkv:${requestId}]   body[0..500]=${body.slice(0, 500)}`,
  );

  const dump = openDump(kind, requestId, startedAt, {
    kind,
    requestId,
    fetchUrl,
    total,
    effectiveMaxTokens,
    estInputTokens,
    estOutputTokens,
    estCombined,
    promptStats: {
      min: promptMin,
      avg: promptAvg,
      max: promptMax,
      totalChars: promptTotalChars,
    },
    bodyBytes: body.length,
    requestBody: body,
  });

  const abortController = new AbortController();

  let upstream: Response;
  try {
    upstream = await fetch(fetchUrl, {
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
    closeDump(dump, {
      outcome: "fetch_failed",
      errorMessage: (err as Error)?.message,
    });
    return new Response(
      JSON.stringify({ error: (err as Error)?.message ?? "upstream fetch failed" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...NO_CACHE_HEADERS },
      },
    );
  }

  const upstreamHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    upstreamHeaders[key] = value;
  });
  console.log(
    `[rwkv:${requestId}] upstream status=${upstream.status} t=${Date.now() - startedAt}ms headers=${JSON.stringify(upstreamHeaders)}`,
  );

  if (!upstream.ok || !upstream.body) {
    const text = upstream.body ? await upstream.text() : "";
    console.error(
      `[rwkv:${requestId}] upstream error status=${upstream.status} url=${fetchUrl}`,
    );
    console.error(
      `[rwkv:${requestId}] upstream raw body[0..1000]=${text.slice(0, 1000)}`,
    );
    if (text) dumpChunk(dump, new TextEncoder().encode(text));
    closeDump(dump, {
      status: upstream.status,
      outcome: "upstream_error_status",
    });
    return new Response(text || `upstream ${upstream.status}`, {
      status: upstream.status || 502,
      headers: NO_CACHE_HEADERS,
    });
  }

  const upstreamReader = upstream.body.getReader();
  let downstreamCancelled = false;

  const passthrough = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamReader;
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
          dumpChunk(dump, value);
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
        closeDump(dump, {
          outcome:
            chunks === 0 && bytes === 0 && !downstreamCancelled
              ? "empty_body"
              : downstreamCancelled
                ? "downstream_cancelled"
                : "ok",
        });
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
              `[rwkv:${requestId}]   curl -sS -X POST '${fetchUrl}' -H 'Content-Type: application/json' --data @${path} -N | head`,
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
        closeDump(dump, {
          outcome: aborted ? "aborted" : "stream_error",
          errorCode: e?.code,
          errorMessage: e?.message,
        });
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
  "worldbuilding": {
    "setting": "故事背景：时代、地点、社会结构（100-150字）",
    "rules": "世界观规则或力量体系（50-100字）",
    "themes": "核心主题（30-50字）",
    "characters": [
      {"name": "姓名", "role": "主角/配角", "personality": "性格特点", "background": "人物背景"}
    ]
  },
  "chapters": [
    {
      "chapter": "第一章",
      "title": "章节标题",
      "outline": "本章梗概（50-100字）",
      "paragraphs": [
        {"outline": "第1段内容要点（30-50字）"},
        {"outline": "第2段内容要点（30-50字）"},
        {"outline": "第3段内容要点（30-50字）"}
      ]
    }
  ]
}`;

  return Array.from({ length: count }, (_, index) => {
    const style = OUTLINE_STYLES[index % OUTLINE_STYLES.length];
    const batchNo = Math.floor(index / OUTLINE_STYLES.length) + 1;
    const differentiation =
      batchNo > 1
        ? `补充要求：与同风格方案保持显著差异，重点突出第${batchNo}套创意路线。`
        : "";

    return `User: 设计一份完整的[${genre}]小说世界观与大纲，共${chapters}章。要求风格：${style}。

这是第一轮：请输出完整世界观设定（故事背景、人物信息、世界观规则）和章节结构。每章必须拆分为3个段落要点。

请以JSON格式输出，格式如下：
${jsonExample}

要求：
1. title要有吸引力
2. summary要详细（100-200字）
3. worldbuilding必须完整：setting/rules/themes/characters（至少3个主要人物）
4. chapters数组包含${chapters}个章节
5. 每章outline要详细（50-100字）
6. 每章paragraphs必须恰好3个，每个outline写清该段情节要点
7. 保持整体节奏统一，主线清晰，人物设定前后一致

${differentiation ? `${differentiation}\n` : ""}

直接输出JSON，不要其他说明。\n\nAssistant: <think>\n</think>\n\`\`\`json\n`;
  });
}

export interface ChapterOutlineEntry {
  title: string;
  outline: string;
}

export interface ParagraphPromptInput {
  novelTitle: string;
  novelSummary: string;
  worldbuildingText: string;
  chapterTitle: string;
  chapterOutline: string;
  chapterNumber: number;
  totalChapters: number;
  paragraphNumber: number;
  totalParagraphs: number;
  paragraphOutline: string;
  allChapterOutlines: ChapterOutlineEntry[];
  previousParagraphContent?: string;
  previousChapterContent?: string;
}

const PREVIOUS_TEXT_MAX_CHARS = 1200;

function formatChapterOutlineList(entries: ChapterOutlineEntry[]): string {
  if (entries.length === 0) return "（暂无章节梗概）";
  return entries
    .map((entry, index) => `第${index + 1}章 ${entry.title}：${entry.outline}`)
    .join("\n");
}

function trimPreviousText(content: string | undefined, emptyLabel: string): string {
  const trimmed = content?.trim();
  if (!trimmed) return emptyLabel;
  if (trimmed.length <= PREVIOUS_TEXT_MAX_CHARS) return trimmed;
  return `…${trimmed.slice(-PREVIOUS_TEXT_MAX_CHARS)}`;
}

function buildParagraphContextBlock(task: ParagraphPromptInput): string {
  return `【全书设定】
书名：${task.novelTitle.trim() || "（未定书名）"}
梗概：${task.novelSummary.trim() || "（暂无全书梗概）"}

${task.worldbuildingText.trim() || "（暂无世界观）"}

【各章梗概】
${formatChapterOutlineList(task.allChapterOutlines)}

【上一章正文】
${trimPreviousText(task.previousChapterContent, "（本章为开篇章，无上章正文）")}

【本章已写段落】
${trimPreviousText(task.previousParagraphContent, "（本章第一段，无上段正文）")}`;
}

/**
 * 第二轮：只生成当前段落草稿（80-120字）。
 */
export function buildChapterPrompts(tasks: ParagraphPromptInput[]): string[] {
  return tasks.map((task) => {
    const context = buildParagraphContextBlock(task);
    return `User: 你是专业小说作家。这是第二轮：只写当前段落的草稿，80-120字，不要写其他段落。

${context}

【当前段落任务】
第${task.chapterNumber}章（共${task.totalChapters}章）${task.chapterTitle} —— 第${task.paragraphNumber}/${task.totalParagraphs}段
段落要点：${task.paragraphOutline}

要求：
1. 只输出当前这一段，紧接上文自然起笔
2. 人物性格、称谓与世界观保持一致
3. 仅输出 JSON：{"content":"..."}

Assistant: \`\`\`json\n`;
  });
}

export interface ExpandTaskInput extends ParagraphPromptInput {
  currentContent: string;
}

/**
 * 第三轮：扩写当前段落，单次扩写；前端可重复调用直到达标。
 */
export function buildExpandPrompts(tasks: ExpandTaskInput[]): string[] {
  return tasks.map((task) => {
    const context = buildParagraphContextBlock(task);
    return `User: 你是专业小说作家。这是第三轮：扩写下面这一段到 200-300 字，只输出当前段落。

${context}

【当前段落任务】
第${task.chapterNumber}章（共${task.totalChapters}章）${task.chapterTitle} —— 第${task.paragraphNumber}/${task.totalParagraphs}段
段落要点：${task.paragraphOutline}

【待扩写段落草稿】
${task.currentContent}

要求：
1. 保留草稿核心情节，补充细节、动作与心理描写
2. 不要改动人设，不要写到其他段落
3. 仅输出 JSON：{"content":"..."}

Assistant: \`\`\`json\n`;
  });
}

/** @deprecated 兼容旧引用，请使用 ParagraphPromptInput */
export type ChapterPromptInput = ParagraphPromptInput;
