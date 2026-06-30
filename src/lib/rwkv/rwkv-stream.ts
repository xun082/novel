import { NO_CACHE_HEADERS } from "@/lib/http/cache-headers";
import {
  RWKV_API_PASSWORD,
  RWKV_CALL_PARAMS,
  RWKV_ENDPOINT,
  type RwkvCallKind,
  type RwkvSamplingParams,
} from "./rwkv-config";
import {
  rwkvResolvedUrlSchema,
  upstreamStreamRequestSchema,
} from "./rwkv-schema";
import {
  closeDump,
  dumpChunk,
  openDump,
} from "./rwkv-stream-dump";

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

const LOG_PROGRESS_INTERVAL_MS = 5000;

function estimateInputTokens(contents: string[]): number {
  let totalChars = 0;
  for (const c of contents) totalChars += c.length;
  return Math.ceil(totalChars / CHARS_PER_TOKEN_ESTIMATE);
}

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
    repetition_penalty: params.repetitionPenalty,
    chunk_size: params.chunkSize,
    stream: true,
  };
  if (password !== undefined && password !== "") {
    body.password = password;
  }
  return JSON.stringify(body);
}

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
  const url = v.upstreamUrl ?? RWKV_ENDPOINT;
  const passwordRaw = v.password ?? RWKV_API_PASSWORD;
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

  console.log(`[rwkv:${requestId}] POST ${fetchUrl}`);
  console.log(
    `[rwkv:${requestId}] sending ${total} prompts (max_tokens=${effectiveMaxTokens}, est_output=${estOutputTokens}, est_input=${estInputTokens}, est_combined=${estCombined}/${TOTAL_COMBINED_BUDGET})`,
  );
  console.log(
    `[rwkv:${requestId}]   prompt_chars min/avg/max=${promptMin}/${promptAvg}/${promptMax} total_input_chars=${promptTotalChars} body_bytes=${body.length}`,
  );
  console.log(`[rwkv:${requestId}]   body[0..500]=${body.slice(0, 500)}`);

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
