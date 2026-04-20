/**
 * RWKV API Service
 * 客户端封装：按业务拆分的专用 Next.js API 路由
 *   - POST /api/outlines  生成多份大纲
 *   - POST /api/chapters  基于梗概并发生成章节正文
 *   - POST /api/expand    对现有章节正文并发扩写
 */

// ========== 类型定义 ==========

export interface RWKVConfig {
  endpoints?: Partial<RWKVEndpoints>;
  maxTokens?: number;
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
  private maxTokens: number;

  private normalizeMaxTokens(value?: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) return 7000;
    return Math.max(6000, Math.floor(value));
  }

  constructor(config?: RWKVConfig) {
    this.endpoints = { ...DEFAULT_ENDPOINTS, ...(config?.endpoints || {}) };
    const envMaxTokens = process.env.NEXT_PUBLIC_RWKV_MAX_TOKENS
      ? Number(process.env.NEXT_PUBLIC_RWKV_MAX_TOKENS)
      : undefined;
    this.maxTokens = this.normalizeMaxTokens(config?.maxTokens ?? envMaxTokens);
  }

  setMaxTokens(maxTokens: number): void {
    this.maxTokens = this.normalizeMaxTokens(maxTokens);
  }

  private async postAndStream(
    endpoint: string,
    payload: Record<string, unknown>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const body = JSON.stringify({ ...payload, maxTokens: this.maxTokens });
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

    return this.consumeStream(response, onUpdate);
  }

  private async consumeStream(
    response: Response,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const accumulated: Record<number, string> = {};
    const finishReasons: Record<number, string> = {};
    let buffer = "";
    let chunkCount = 0;

    const handleParsed = (payload: unknown) => {
      if (!isStreamPayload(payload) || !payload.choices) return;
      for (const choice of payload.choices) {
        const index = choice.index ?? 0;
        if (choice.finish_reason) {
          finishReasons[index] = String(choice.finish_reason);
        }
        const delta =
          choice.delta?.content || choice.message?.content || choice.text || "";
        if (!delta) continue;

        accumulated[index] = (accumulated[index] || "") + delta;
        if (onUpdate) onUpdate(index, accumulated[index]);
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

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkCount++;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      }
      if (buffer.trim()) processLine(buffer);
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
  ): Promise<string[]> {
    return this.postAndStream(
      this.endpoints.outlines,
      { genre, chapters, count },
      onUpdate,
    );
  }

  async generateNovelOutline(
    genre: string = "玄幻",
    chapters: number = 15,
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
   * 跨多个大纲并发生成章节正文
   */
  async generateChaptersByTasks(
    tasks: Array<{
      novelContext: { title: string; summary: string };
      chapter: { title: string; outline: string };
      chapterOrder: number;
      chapterTotal: number;
    }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    return this.postAndStream(this.endpoints.chapters, { tasks }, onUpdate);
  }

  /**
   * 单大纲章节正文生成（保留兼容）
   */
  async generateChapters(
    novelContext: { title: string; summary: string },
    chapters: Array<{ title: string; outline: string }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const tasks = chapters.map((chapter, index) => ({
      novelContext,
      chapter,
      chapterOrder: index + 1,
      chapterTotal: chapters.length,
    }));
    return this.generateChaptersByTasks(tasks, onUpdate);
  }

  /**
   * 并发扩写已有章节正文
   */
  async expandChapters(
    chapters: Array<{ title: string; outline: string; currentContent: string }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    return this.postAndStream(this.endpoints.expand, { chapters }, onUpdate);
  }
}

// ========== 导出 ==========

export const rwkvService = new RWKVService();
export { RWKVService };
export default rwkvService;
