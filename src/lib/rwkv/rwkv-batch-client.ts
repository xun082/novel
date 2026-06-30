import {
  DEFAULT_RWKV_DECODE_CONFIG,
  RWKV_API_PASSWORD,
  RWKV_ENDPOINT,
  RwkvDecodeConfig,
  mergeDecodeConfig,
} from "./rwkv-config";

/**
 * batch 任务的业务定位。`index` 永远是 batch 内的位置；业务层用 target 找到自己的数据节点。
 */
export interface BatchTarget {
  novelIndex: number;
  chapterIndex?: number;
  paragraphIndex?: number;
}

export interface BatchChunkPayload {
  index: number;
  target: BatchTarget;
  delta: string;
  buffer: string;
}

export interface BatchResultItem {
  index: number;
  target: BatchTarget;
  rawText: string;
}

export interface BatchCompletionOptions {
  contents: string[];
  targets: BatchTarget[];
  decodeConfig?: Partial<RwkvDecodeConfig>;
  endpoint?: string;
  password?: string;
  signal?: AbortSignal;
  onChunk?: (chunk: BatchChunkPayload) => void;
  onComplete?: (results: BatchResultItem[]) => void;
}

interface SseChoiceDelta {
  content?: string;
}
interface SseChoice {
  index?: number;
  delta?: SseChoiceDelta;
  text?: string;
}
interface SseChunk {
  choices?: SseChoice[];
}

/**
 * 一次性把 contents 全部送给上游 /big_batch/completions。
 * 上游 SSE 一帧 data 中可能同时包含多个 choices，必须遍历全部 choices，
 * 按 choice.index 分流到 buffers[i] 与 targets[i]。
 */
export async function rwkvBatchCompletion(
  opts: BatchCompletionOptions,
): Promise<BatchResultItem[]> {
  const { contents, targets, onChunk, onComplete, signal } = opts;
  if (contents.length === 0) {
    onComplete?.([]);
    return [];
  }
  if (contents.length !== targets.length) {
    throw new Error(
      `contents.length (${contents.length}) must match targets.length (${targets.length})`,
    );
  }

  const decodeConfig = mergeDecodeConfig(opts.decodeConfig);
  const endpoint = opts.endpoint ?? RWKV_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "RWKV endpoint is not configured: set RWKV_UPSTREAM_URL or pass opts.endpoint",
    );
  }
  const password = opts.password ?? RWKV_API_PASSWORD;

  const payload: Record<string, unknown> = {
    contents,
    max_tokens: decodeConfig.max_tokens,
    temperature: decodeConfig.temperature,
    top_k: decodeConfig.top_k,
    top_p: decodeConfig.top_p,
    alpha_presence: decodeConfig.alpha_presence,
    alpha_frequency: decodeConfig.alpha_frequency,
    alpha_decay: decodeConfig.alpha_decay,
    stream: true,
  };
  if (password) payload.password = password;
  const body = JSON.stringify(payload);

  if (signal?.aborted) throw new Error("aborted");
  const result = await streamOnce({
    endpoint,
    body,
    targets,
    contentCount: contents.length,
    signal,
    onChunk,
  });
  onComplete?.(result);
  return result;
}

interface StreamOnceOptions {
  endpoint: string;
  body: string;
  targets: BatchTarget[];
  contentCount: number;
  signal?: AbortSignal;
  onChunk?: (chunk: BatchChunkPayload) => void;
}

async function streamOnce(opts: StreamOnceOptions): Promise<BatchResultItem[]> {
  const { endpoint, body, targets, contentCount, signal, onChunk } = opts;
  const buffers: string[] = Array.from({ length: contentCount }, () => "");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body,
    cache: "no-store",
    signal,
    // @ts-expect-error undici 半双工流
    duplex: "half",
  });

  if (!response.ok || !response.body) {
    const text = response.body ? await response.text() : "";
    throw new Error(
      `rwkv upstream ${response.status} ${response.statusText}: ${text.slice(0, 400)}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let lineBuf = "";
  let receivedBytes = 0;

  const flushLine = (rawLine: string) => {
    const line = rawLine.trim();
    if (!line || !line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;

    let chunk: SseChunk;
    try {
      chunk = JSON.parse(data) as SseChunk;
    } catch {
      return;
    }
    if (!chunk.choices || chunk.choices.length === 0) return;

    for (const choice of chunk.choices) {
      const idx = typeof choice.index === "number" ? choice.index : -1;
      if (idx < 0 || idx >= buffers.length) continue;
      const delta = choice.delta?.content ?? choice.text ?? "";
      if (!delta) continue;
      buffers[idx] += delta;
      onChunk?.({
        index: idx,
        target: targets[idx],
        delta,
        buffer: buffers[idx],
      });
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.length;
      lineBuf += decoder.decode(value, { stream: true });

      // SSE 帧之间用 \n\n 分隔，但单帧里也可能是若干个 `data:` 行；按行分割并丢给 flushLine 即可。
      let nlIdx: number;
      while ((nlIdx = lineBuf.indexOf("\n")) !== -1) {
        const line = lineBuf.slice(0, nlIdx);
        lineBuf = lineBuf.slice(nlIdx + 1);
        flushLine(line);
      }
    }
    if (lineBuf.length > 0) flushLine(lineBuf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  if (receivedBytes === 0) {
    throw new Error("rwkv upstream returned 200 with EMPTY body");
  }

  return buffers.map((rawText, index) => ({
    index,
    target: targets[index],
    rawText,
  }));
}

export { DEFAULT_RWKV_DECODE_CONFIG };
