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
  /** 可选的全局 max_tokens 覆盖值；不设则由服务端按 endpoint 选择默认值 */
  private maxTokens?: number;

  private normalizeMaxTokens(value?: number): number | undefined {
    if (typeof value !== "number" || Number.isNaN(value)) return undefined;
    return Math.max(1, Math.floor(value));
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
    const finalPayload: Record<string, unknown> = { ...payload };
    if (typeof this.maxTokens === "number") {
      finalPayload.maxTokens = this.maxTokens;
    }
    const body = JSON.stringify(finalPayload);
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
   * 一次性高并发生成所有章节正文：
   *   - 前端按扁平 tasks 传入；
   *   - service 按 novelContext 自动聚合成 { outlines: [{ title, summary, chapters }] }，
   *     summary 每份大纲只出现一次（不因章节数重复）；
   *   - 仅发一次 POST /api/chapters，让上游 /big_batch 在同一请求内并发跑全部 prompts；
   *   - 服务端上游按 contents[] 下标返回，service 再按原始 tasks 顺序重排。
   */
  async generateChaptersByTasks(
    tasks: Array<{
      novelContext: { title: string; summary: string };
      chapter: { title: string; outline: string };
    }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    if (tasks.length === 0) return [];

    interface Group {
      title: string;
      summary: string;
      chapters: Array<{ title: string; outline: string }>;
      /** 该 group 内第 k 个 chapter 对应的原始 task 下标 */
      taskIndices: number[];
    }

    const groups: Group[] = [];
    const keyToGroup = new Map<string, Group>();

    for (let i = 0; i < tasks.length; i++) {
      const { novelContext, chapter } = tasks[i];
      const key = `${novelContext.title}\u0000${novelContext.summary}`;
      let group = keyToGroup.get(key);
      if (!group) {
        group = {
          title: novelContext.title,
          summary: novelContext.summary,
          chapters: [],
          taskIndices: [],
        };
        keyToGroup.set(key, group);
        groups.push(group);
      }
      group.chapters.push(chapter);
      group.taskIndices.push(i);
    }

    // 上游按 contents[] 下标返回，而 contents 就是 groups 依次拼接而成。
    // 所以 flatIndex = 组在 groups 的前缀 chapter 数 + 组内位置。
    const flatToTaskIndex: number[] = [];
    for (const group of groups) {
      for (const taskIdx of group.taskIndices) {
        flatToTaskIndex.push(taskIdx);
      }
    }

    const outlinesPayload = groups.map((g) => ({
      title: g.title,
      summary: g.summary,
      chapters: g.chapters,
    }));

    const flatResults = await this.postAndStream(
      this.endpoints.chapters,
      { outlines: outlinesPayload },
      onUpdate
        ? (flatIndex, content) => {
            const taskIndex = flatToTaskIndex[flatIndex];
            if (typeof taskIndex === "number") onUpdate(taskIndex, content);
          }
        : undefined,
    );

    const merged: string[] = Array.from({ length: tasks.length }, () => "");
    for (let flat = 0; flat < flatResults.length; flat++) {
      const taskIndex = flatToTaskIndex[flat];
      if (typeof taskIndex === "number") merged[taskIndex] = flatResults[flat];
    }
    return merged;
  }

  /**
   * 单大纲章节正文生成（内部仍走同一个 /api/chapters，包成单份 outlines 发送）
   */
  async generateChapters(
    novelContext: { title: string; summary: string },
    chapters: Array<{ title: string; outline: string }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const tasks = chapters.map((chapter) => ({ novelContext, chapter }));
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
