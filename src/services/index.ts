/**
 * RWKV API Service
 * 客户端封装：按业务拆分的专用 Next.js API 路由
 *   - POST /api/outlines  第一轮：生成世界观与章节段落结构
 *   - POST /api/chapters  第二轮：按段落生成草稿
 *   - POST /api/expand    第三轮：扩写段落（可重复直到达标）
 */

import { rwkvCredentialsForApiBody } from "@/lib/rwkv-client-settings";
import type {
  ParagraphExpandTask,
  ParagraphGenerationTask,
} from "@/lib/novel-generation";

// ========== 类型定义 ==========

export interface RWKVConfig {
  endpoints?: Partial<RWKVEndpoints>;
}

export interface RWKVEndpoints {
  outlines: string;
  chapters: string;
  expand: string;
}

export interface RWKVResponse {
  choices?: Array<{
    index?: number;
    text?: string;
    message?: {
      role?: string;
      content?: string;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

interface StreamChoice {
  index?: number;
  finish_reason?: string | null;
  delta?: { content?: string };
  message?: { content?: string };
  text?: string;
}

interface StreamPayload {
  choices?: StreamChoice[];
}

function isStreamPayload(value: unknown): value is StreamPayload {
  if (typeof value !== "object" || value === null) return false;
  const maybeChoices = (value as { choices?: unknown }).choices;
  return Array.isArray(maybeChoices);
}

const RWKV_DEBUG = process.env.NEXT_PUBLIC_RWKV_DEBUG === "1";

const debugLog = (...args: unknown[]) => {
  if (RWKV_DEBUG) console.log(...args);
};
const debugWarn = (...args: unknown[]) => {
  if (RWKV_DEBUG) console.warn(...args);
};
const debugError = (...args: unknown[]) => {
  if (RWKV_DEBUG) console.error(...args);
};

const DEFAULT_ENDPOINTS: RWKVEndpoints = {
  outlines: "/api/outlines",
  chapters: "/api/chapters",
  expand: "/api/expand",
};

// ========== Service ==========

class RWKVService {
  private endpoints: RWKVEndpoints;

  constructor(config?: RWKVConfig) {
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(config?.endpoints || {}) };
  }

  private async postAndStream(
    endpoint: string,
    payload: Record<string, unknown>,
    onUpdate?: (index: number, content: string) => void,
    onComplete?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const body = JSON.stringify({
      ...payload,
      ...rwkvCredentialsForApiBody(),
    });
    debugLog(`POST ${endpoint}`, body.length, "bytes");

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store, no-cache",
        Pragma: "no-cache",
      },
      body,
      cache: "no-store",
      keepalive: false,
    });

    if (!response.ok) {
      const errorText = await response.text();
      debugError(`接口响应错误 ${endpoint}:`, response.status, errorText);
      throw new Error(
        `HTTP ${response.status} @ ${endpoint}: ${errorText.slice(0, 200)}`,
      );
    }

    if (!response.body) {
      debugWarn(`${endpoint} 无 body，尝试 JSON 解析`);
      const fallback = (await response.json()) as RWKVResponse;
      return this.extractAllContents(fallback);
    }

    return this.consumeStream(response, onUpdate, onComplete);
  }

  private async consumeStream(
    response: Response,
    onUpdate?: (index: number, content: string) => void,
    onComplete?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const accumulated: Record<number, string> = {};
    const completedIndexes = new Set<number>();
    let buffer = "";
    let chunkCount = 0;

    const handleParsed = (payload: unknown) => {
      if (!isStreamPayload(payload) || !payload.choices) return;
      for (const choice of payload.choices) {
        if (typeof choice.index !== "number" || !Number.isFinite(choice.index)) {
          continue;
        }
        const index = choice.index;
        const delta =
          choice.delta?.content || choice.message?.content || choice.text || "";
        if (delta) {
          accumulated[index] = (accumulated[index] || "") + delta;
          if (onUpdate) onUpdate(index, accumulated[index]);
        }

        if (choice.finish_reason && !completedIndexes.has(index)) {
          completedIndexes.add(index);
          if (onComplete) onComplete(index, accumulated[index] || "");
        }
      }
    };

    const processLine = (rawLine: string) => {
      const trimmed = rawLine.trim();
      if (!trimmed) return;

      let parsed: unknown = null;
      if (trimmed.startsWith("data:")) {
        const data = trimmed.replace(/^data:\s*/, "");
        if (data === "[DONE]") return;
        try {
          parsed = JSON.parse(data);
        } catch {
          debugWarn("SSE 解析失败:", data.substring(0, 160));
          return;
        }
      } else if (trimmed.startsWith("{")) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          debugWarn("NDJSON 解析失败:", trimmed.substring(0, 160));
          return;
        }
      } else {
        return;
      }
      handleParsed(parsed);
    };

    /** 让出主线程，避免单次 read 内成百上千次 setState 被 React 一次性批处理、界面长时间不刷新 */
    const yieldForPaint = () =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

    try {
      let linesSinceYield = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkCount++;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          processLine(line);
          if (onUpdate) {
            linesSinceYield += 1;
            // 每处理若干行让出一次，使各卡片流式内容能逐段上屏
            if (linesSinceYield >= 4) {
              linesSinceYield = 0;
              await yieldForPaint();
            }
          }
        }
      }
      if (buffer.trim()) processLine(buffer);

      // 兜底：部分上游不回 finish_reason，流关闭后把已收到内容统一视为完成
      if (onComplete) {
        for (const [idxRaw, content] of Object.entries(accumulated)) {
          const idx = Number(idxRaw);
          if (!completedIndexes.has(idx)) {
            onComplete(idx, content || "");
            completedIndexes.add(idx);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    debugLog(`流式结束：接收 ${chunkCount} 块，索引数 ${Object.keys(accumulated).length}`);

    const maxIndex = Object.keys(accumulated).reduce(
      (max, key) => Math.max(max, Number(key)),
      -1,
    );
    const result = Array.from({ length: maxIndex + 1 }, () => "");
    for (const [key, content] of Object.entries(accumulated)) {
      result[Number(key)] = content;
    }
    return result;
  }

  private extractAllContents(response: RWKVResponse): string[] {
    if (!response.choices || response.choices.length === 0) return [];
    const maxIndex = response.choices.reduce((max, choice) => {
      const idx = typeof choice.index === "number" ? choice.index : -1;
      return idx > max ? idx : max;
    }, -1);
    if (maxIndex >= 0) {
      const out = Array.from({ length: maxIndex + 1 }, () => "");
      for (const choice of response.choices) {
        const idx = typeof choice.index === "number" ? choice.index : -1;
        const content = choice.message?.content || choice.text || "";
        if (idx >= 0) out[idx] = content;
      }
      return out;
    }
    return response.choices.map(
      (choice) => choice.message?.content || choice.text || "",
    );
  }

  /**
   * 并发生成多份大纲
   */
  async generateMultipleOutlines(
    genre: string,
    chapters: number,
    count: number,
    onUpdate?: (index: number, content: string) => void,
    onComplete?: (index: number, content: string) => void,
  ): Promise<string[]> {
    return this.postAndStream(
      this.endpoints.outlines,
      { genre, chapters, count },
      onUpdate,
      onComplete,
    );
  }

  async generateNovelOutline(
    genre: string = "玄幻",
    chapters: number = 8,
    onUpdate?: (content: string) => void,
  ): Promise<string> {
    const [first] = await this.generateMultipleOutlines(
      genre,
      chapters,
      1,
      onUpdate ? (_, content) => onUpdate(content) : undefined,
    );
    return first || "";
  }

  /**
   * 第二轮：并发生成段落草稿。
   */
  async generateParagraphDrafts(
    paragraphs: ParagraphGenerationTask[],
    onUpdate?: (index: number, content: string) => void,
    onComplete?: (index: number, content: string) => void,
  ): Promise<string[]> {
    if (paragraphs.length === 0) return [];

    return this.postAndStream(
      this.endpoints.chapters,
      { chapters: paragraphs },
      onUpdate,
      onComplete,
    );
  }

  /**
   * 第三轮：扩写段落（单次）；前端可循环调用直到字数达标。
   */
  async expandParagraphs(
    paragraphs: ParagraphExpandTask[],
    onUpdate?: (index: number, content: string) => void,
    onComplete?: (index: number, content: string) => void,
  ): Promise<string[]> {
    if (paragraphs.length === 0) return [];

    return this.postAndStream(
      this.endpoints.expand,
      { chapters: paragraphs },
      onUpdate,
      onComplete,
    );
  }
}

// ========== 导出 ==========

export const rwkvService = new RWKVService();
export { RWKVService };
export default rwkvService;
