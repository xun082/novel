const UPSTREAM = "http://154.37.222.49:8193/big_batch/completions";
const DEFAULT_PASSWORD = "rwkv-7b13b-fyrik-13b";
const DEFAULT_MAX_TOKENS = 7000;
const DEFAULT_BATCH_SIZE = 10;

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
  /** 单次上游请求的最大 content 条数；超过后分批顺序请求 */
  batchSize?: number;
}

function buildUpstreamBody(contents: string[], opts: UpstreamOptions): string {
  return JSON.stringify({
    contents,
    max_tokens: Math.max(6000, opts.maxTokens ?? DEFAULT_MAX_TOKENS),
    stop_tokens: opts.stopTokens ?? [0],
    temperature: opts.temperature ?? 0.9,
    chunk_size: opts.chunkSize ?? 8,
    stream: true,
    password: opts.password ?? DEFAULT_PASSWORD,
  });
}

/**
 * 重新生成一行 SSE/NDJSON，把其中的 choices[].index 加上 offset。
 * 返回已序列化的一行（不含结尾换行），或 null 表示忽略该行。
 */
function rewriteLineWithOffset(line: string, offset: number): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let prefix = "";
  let jsonText: string | null = null;

  if (trimmed.startsWith("data:")) {
    prefix = "data: ";
    const data = trimmed.replace(/^data:\s*/, "");
    if (data === "[DONE]") return null;
    jsonText = data;
  } else if (trimmed.startsWith("{")) {
    jsonText = trimmed;
  } else {
    return null;
  }

  try {
    const payload = JSON.parse(jsonText) as {
      choices?: Array<{ index?: number; [key: string]: unknown }>;
      [key: string]: unknown;
    };
    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (typeof choice.index === "number") {
          choice.index = choice.index + offset;
        } else if (offset > 0) {
          choice.index = offset;
        }
      }
    }
    return `${prefix}${JSON.stringify(payload)}`;
  } catch {
    return null;
  }
}

async function pipeBatchToController(
  batchContents: string[],
  offset: number,
  opts: UpstreamOptions,
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
): Promise<{ ok: boolean; error?: string }> {
  const upstream = await fetch(UPSTREAM, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: buildUpstreamBody(batchContents, opts),
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    const text = upstream.body ? await upstream.text() : "";
    return {
      ok: false,
      error: `batch@${offset} upstream ${upstream.status} ${text.slice(0, 200)}`,
    };
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const raw of lines) {
        const rewritten = rewriteLineWithOffset(raw, offset);
        if (rewritten !== null) {
          controller.enqueue(encoder.encode(`${rewritten}\n\n`));
        }
      }
    }
    if (buffer.trim()) {
      const rewritten = rewriteLineWithOffset(buffer, offset);
      if (rewritten !== null) {
        controller.enqueue(encoder.encode(`${rewritten}\n\n`));
      }
    }
    return { ok: true };
  } finally {
    reader.releaseLock();
  }
}

export async function callUpstreamStream(opts: UpstreamOptions): Promise<Response> {
  const total = opts.contents.length;
  const batchSize = Math.max(1, opts.batchSize ?? DEFAULT_BATCH_SIZE);

  // 单批无需合并，直通上游即可
  if (total <= batchSize) {
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: buildUpstreamBody(opts.contents, opts),
      cache: "no-store",
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      console.error("[rwkv] upstream error", upstream.status, text.slice(0, 300));
      return new Response(text, {
        status: upstream.status,
        headers: NO_CACHE_HEADERS,
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("Content-Type") ?? "text/event-stream",
        ...NO_CACHE_HEADERS,
      },
    });
  }

  // 多批：手动组合成一条 SSE 返回
  const encoder = new TextEncoder();
  const totalBatches = Math.ceil(total / batchSize);
  console.log(
    `[rwkv] batching ${total} prompts into ${totalBatches} batches of ${batchSize}`,
  );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (let batchIdx = 0; batchIdx < totalBatches; batchIdx++) {
          const offset = batchIdx * batchSize;
          const slice = opts.contents.slice(offset, offset + batchSize);
          console.log(
            `[rwkv] batch ${batchIdx + 1}/${totalBatches} (offset=${offset}, size=${slice.length})`,
          );
          try {
            const result = await pipeBatchToController(
              slice,
              offset,
              opts,
              controller,
              encoder,
            );
            if (!result.ok) {
              console.error(`[rwkv] batch ${batchIdx + 1} failed: ${result.error}`);
            }
          } catch (err) {
            console.error(`[rwkv] batch ${batchIdx + 1} threw`, err);
          }
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      } catch (error) {
        console.error("[rwkv] batched stream error", error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
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
  chapterOrder: number;
  chapterTotal: number;
}

export function buildChapterPrompts(tasks: ChapterTaskInput[]): string[] {
  const jsonExample = `{
  "content": "章节正文内容（800-1200字）"
}`;

  return tasks.map(
    ({ novelContext, chapter, chapterOrder, chapterTotal }) =>
      `User: 写小说章节正文，严格按照章节梗概展开剧情。

【小说背景】
标题：${novelContext.title}
整体梗概：${novelContext.summary}

【当前章节】
章节：${chapter.title}（第 ${chapterOrder}/${chapterTotal} 章）
本章梗概：${chapter.outline}

【写作任务】
⚠️ 核心要求：必须严格按照"本章梗概"描述的剧情来写！

1. 仔细阅读本章梗概，理解核心剧情和发展要点
2. 完整展现梗概中的所有关键情节
3. 不要添加梗概外的剧情，不要偏离主线
4. 适当添加对话、动作、环境描写等细节
5. 严格控制字数：600-800字
6. 只写这一章，不要涉及其他章节

【格式要求】
- 小说正文格式，段落间用空行（\\n\\n）分隔
- 以JSON格式输出
- 不要添加任何额外说明或标记

【输出格式】
${jsonExample}

注意：内容必须完全符合本章梗概的要求。\n\nAssistant: \`\`\`json\n`,
  );
}

export interface ExpandTaskInput {
  title: string;
  outline: string;
  currentContent: string;
}

export function buildExpandPrompts(tasks: ExpandTaskInput[]): string[] {
  const jsonExample = `{
  "content": "扩写后的完整内容（1500-2000字）"
}`;

  return tasks.map(
    (chapter) =>
      `User: 扩写小说章节，严格按照章节梗概进行扩写。

【章节信息】
标题：${chapter.title}
章节梗概：${chapter.outline}
当前字数：${chapter.currentContent.length}字

【现有内容】
${chapter.currentContent}

【扩写任务】
⚠️ 重要：必须严格按照"章节梗概"中描述的剧情进行扩写！

1. 仔细阅读章节梗概，理解本章的核心剧情和发展方向
2. 在现有内容基础上续写，推进梗概中描述的剧情
3. 确保扩写内容完整覆盖梗概中的所有关键情节
4. 增加对话、动作、心理活动等细节描写
5. 扩写后总字数控制在1200-1500字
6. 不要偏离梗概，不要添加梗概外的剧情

【写作要求】
- 紧扣章节梗概，逐步展开梗概中的情节
- 保持原文风格和叙事节奏
- 段落之间用空行（\\n\\n）分隔
- 以JSON格式输出完整内容

【输出格式】
${jsonExample}

注意：扩写内容必须符合章节梗概的要求。\n\nAssistant: \`\`\`json\n`,
  );
}
