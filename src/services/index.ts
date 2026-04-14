/**
 * RWKV API Service
 * 封装 RWKV 模型 API 调用
 */

// ========== 类型定义 ==========

export interface RWKVConfig {
  apiPath?: string;
  password?: string;
  maxTokens?: number;
}

export interface RWKVResponse {
  choices?: Array<{
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

// 内部请求参数（固定配置）
interface RWKVRequestBody {
  contents: string[];
  max_tokens: number;
  stop_tokens: number[];
  temperature: number;
  chunk_size: number;
  stream: boolean;
  password: string;
}

interface StreamChoice {
  index?: number;
  finish_reason?: string | null;
  delta?: {
    content?: string;
  };
  message?: {
    content?: string;
  };
  text?: string;
}

interface StreamPayload {
  choices?: StreamChoice[];
}

function isStreamPayload(value: unknown): value is StreamPayload {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const maybeChoices = (value as { choices?: unknown }).choices;
  return Array.isArray(maybeChoices);
}

// ========== RWKV Service 类 ==========

class RWKVService {
  private apiPath: string;
  private password: string;
  private maxTokens: number;
  private stopTokens: number[];

  private normalizeMaxTokens(value?: number): number {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return 7000;
    }
    return Math.max(6000, Math.floor(value));
  }

  constructor(config?: RWKVConfig) {
    this.apiPath = config?.apiPath || "/api/prompt";
    this.password = config?.password || "rwkv-7b13b-fyrik-13b";
    // 优先级：显式配置 > 环境变量 > 默认值（7000），并强制下限 6000
    const envMaxTokens = process.env.NEXT_PUBLIC_RWKV_MAX_TOKENS
      ? Number(process.env.NEXT_PUBLIC_RWKV_MAX_TOKENS)
      : undefined;
    this.maxTokens = this.normalizeMaxTokens(config?.maxTokens ?? envMaxTokens);
    // 仅保留EOS，避免额外stop token误截断JSON
    this.stopTokens = [0];
  }

  setMaxTokens(maxTokens: number): void {
    this.maxTokens = this.normalizeMaxTokens(maxTokens);
  }

  /**
   * 调用 RWKV API（内部方法）
   * @param contents 内容数组，数组长度决定并发生成的数量
   * @param sessionId 会话ID
   * @param onUpdate 流式更新回调函数
   */
  private async call(
    contents: string[],
    onUpdate?: (index: number, content: string) => void,
    options?: { maxTokens?: number },
  ): Promise<RWKVResponse> {
    const maxTokens = this.normalizeMaxTokens(options?.maxTokens ?? this.maxTokens);
    const requestBody: RWKVRequestBody = {
      contents,
      max_tokens: maxTokens,
      stop_tokens: this.stopTokens,
      temperature: 0.9,
      chunk_size: 8,
      stream: true,
      password: this.password,
    };

    try {
      console.log(
        "发送API请求，stream: true, contents数量:",
        contents.length,
        "max_tokens:",
        maxTokens,
        "stop_tokens:",
        JSON.stringify(this.stopTokens),
      );

      const response = await fetch(this.apiPath, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("API响应错误:", response.status, errorText);
        throw new Error(`HTTP error! status: ${response.status}, ${errorText}`);
      }

      // 检查响应类型
      const contentType = response.headers.get("content-type");
      console.log("响应 Content-Type:", contentType);

      // 始终使用流式处理
      if (response.body) {
        console.log("使用流式处理");
        return await this.handleStreamResponse(response, onUpdate);
      }

      // 降级处理：如果没有body，尝试解析JSON
      console.warn("响应没有body，尝试JSON解析");
      const result: RWKVResponse = await response.json();
      console.log("API响应:", result);

      // 如果有回调函数，立即调用
      if (onUpdate && result.choices) {
        result.choices.forEach((choice, index) => {
          const content = choice.message?.content || choice.text || "";
          if (content) {
            onUpdate(index, content);
          }
        });
      }

      return result;
    } catch (error) {
      console.error("RWKV API 调用失败:", error);
      throw error;
    }
  }

  /**
   * 处理流式响应（支持多种格式）
   */
  private async handleStreamResponse(
    response: Response,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<RWKVResponse> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    // 存储每个并发流的累积内容
    const accumulatedContents: { [index: number]: string } = {};
    const finishReasons: { [index: number]: string } = {};
    let buffer = "";
    let chunkCount = 0;

    const handleParsedChoices = (payload: unknown) => {
      if (!isStreamPayload(payload) || !payload.choices) return;

      for (const choice of payload.choices) {
        const index = choice.index ?? 0;
        if (choice.finish_reason) {
          finishReasons[index] = String(choice.finish_reason);
          console.log(`完成信号 [${index}] finish_reason: ${finishReasons[index]}`);
        }

        // 尝试提取内容（支持多种字段）
        const delta =
          choice.delta?.content || choice.message?.content || choice.text || "";

        if (!delta) continue;

        // 增量更新
        const before = accumulatedContents[index] || "";
        accumulatedContents[index] = before + delta;

        // 调用回调
        if (onUpdate) {
          onUpdate(index, accumulatedContents[index]);
        }

        // 显示增量内容的前20字，帮助确认不同index确实有不同内容
        const deltaPreview = delta.substring(0, 20).replace(/\n/g, "↵");
        console.log(
          `内容更新 [${index}]: +${delta.length}字 "${deltaPreview}..." (总计: ${accumulatedContents[index].length}字)`,
        );
      }
    };

    const processLine = (rawLine: string) => {
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) return;

      let parsed: unknown = null;

      // SSE 格式: data: {...}
      if (trimmedLine.startsWith("data:")) {
        const data = trimmedLine.replace(/^data:\s*/, "");
        if (data === "[DONE]") {
          console.log("收到 [DONE] 标记");
          return;
        }

        try {
          parsed = JSON.parse(data);
        } catch {
          console.warn("SSE 格式解析失败:", data.substring(0, 160));
          return;
        }
      } else if (trimmedLine.startsWith("{")) {
        // NDJSON 格式
        try {
          parsed = JSON.parse(trimmedLine);
        } catch {
          console.warn("JSON 格式解析失败:", trimmedLine.substring(0, 160));
          return;
        }
      } else {
        // 例如 event: message 等非JSON行
        return;
      }

      handleParsedChoices(parsed);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          console.log("流式读取完成，总计接收", chunkCount, "个数据块");
          break;
        }

        chunkCount++;
        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        // 尝试按行分割（支持 SSE 和 NDJSON 格式）
        const lines = buffer.split("\n");

        // 保留最后一行（可能不完整）
        buffer = lines.pop() || "";

        for (const line of lines) {
          processLine(line);
        }
      }

      // 处理剩余的buffer
      if (buffer.trim()) {
        console.log("处理剩余buffer:", buffer.substring(0, 100));
        processLine(buffer);
      }

      console.log(
        "流式处理完成，累积内容:",
        Object.keys(accumulatedContents).length,
        "个",
      );

      // 显示每个index的最终统计和完整内容
      Object.entries(accumulatedContents).forEach(([indexStr, content]) => {
        const preview = content.substring(0, 50).replace(/\n/g, "↵");
        console.log(
          `  [${indexStr}] 最终字数: ${content.length}，前50字: "${preview}..."`,
        );
        console.log(`\n====== 完整输出 [${indexStr}] ======`);
        console.log(content);
        console.log(`====== 结束 [${indexStr}] ======\n`);
      });

      // 构建最终响应
      const finalResponse: RWKVResponse = {
        choices: Object.entries(accumulatedContents).map(
          ([indexStr, content]) => ({
            index: parseInt(indexStr),
            message: {
              role: "assistant",
              content: content,
            },
            finish_reason: finishReasons[parseInt(indexStr)] ?? "stop",
          }),
        ),
      };

      return finalResponse;
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * 提取所有响应内容（用于并发结果）
   */
  private extractAllContents(response: RWKVResponse): string[] {
    if (response.choices && response.choices.length > 0) {
      return response.choices.map(
        (choice) => choice.message?.content || choice.text || "",
      );
    }
    return [];
  }

  /**
   * 提取单个响应内容
   */
  private extractContent(response: RWKVResponse): string {
    const contents = this.extractAllContents(response);
    return contents[0] || "";
  }

  /**
   * 并发生成多个小说大纲（一次调用）
   * @param genre 小说类型
   * @param chapters 章节数量
   * @param count 并发生成数量
   * @param onUpdate 流式更新回调
   */
  async generateMultipleOutlines(
    genre: string,
    chapters: number,
    count: number,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    // JSON格式示例
    const jsonExample = `{
  "title": "小说标题",
  "summary": "核心梗概（100-200字）",
  "chapters": [
    {"chapter": "第一章", "title": "章节标题", "outline": "内容梗概（50-100字）"},
    {"chapter": "第二章", "title": "章节标题", "outline": "内容梗概（50-100字）"}
  ]
}`;

    // 为每个并发生成创建不同的 prompt，加入风格要求
    const styles = [
      "热血冒险",
      "权谋智斗",
      "情感细腻",
      "悬疑推理",
      "轻松幽默",
      "暗黑系",
      "温馨治愈",
      "史诗宏大",
    ];

    const prompts = styles.slice(0, count).map(
      (style) =>
        `User: 写一份[${genre}]小说大纲，共${chapters}章。要求风格：${style}。

请以JSON格式输出，格式如下：
${jsonExample}

要求：
1. title要有吸引力
2. summary要详细（100-200字）
3. chapters数组包含${chapters}个章节
4. 每章outline要详细（50-100字）

直接输出JSON，不要其他说明。\n\nAssistant: <think>\n</think>\n\`\`\`json\n`,
    );

    console.log("生成大纲 prompts数量:", prompts.length);
    prompts.forEach((p, i) => console.log(`  [${i}] ${p.substring(0, 60)}...`));

    const response = await this.call(prompts, onUpdate);
    return this.extractAllContents(response);
  }

  /**
   * 生成单个小说大纲
   */
  async generateNovelOutline(
    genre: string = "玄幻",
    chapters: number = 15,
    onUpdate?: (content: string) => void,
  ): Promise<string> {
    const outlines = await this.generateMultipleOutlines(
      genre,
      chapters,
      1,
      onUpdate ? (index, content) => onUpdate(content) : undefined,
    );
    return outlines[0] || "";
  }

  /**
   * 并发生成章节内容（JSON格式，无深度思考）
   * @param novelContext 小说上下文（标题、梗概）
   * @param chapters 章节信息数组
   * @param onUpdate 流式更新回调
   */
  async generateChapters(
    novelContext: { title: string; summary: string },
    chapters: Array<{ title: string; outline: string }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const jsonExample = `{
  "content": "章节正文内容（800-1200字）"
}`;

    const prompts = chapters.map(
      (chapter, index) =>
        `User: 写小说章节正文，严格按照章节梗概展开剧情。

【小说背景】
标题：${novelContext.title}
整体梗概：${novelContext.summary}

【当前章节】
章节：${chapter.title}（第 ${index + 1}/${chapters.length} 章）
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

    console.log("生成章节 prompts数量:", prompts.length);
    const response = await this.call(prompts, onUpdate);
    return this.extractAllContents(response);
  }

  /**
   * 并发扩写章节内容（JSON格式）
   * @param chapters 需要扩写的章节信息
   * @param onUpdate 流式更新回调
   */
  async expandChapters(
    chapters: Array<{ title: string; outline: string; currentContent: string }>,
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const jsonExample = `{
  "content": "扩写后的完整内容（1500-2000字）"
}`;

    const prompts = chapters.map(
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

    console.log("扩写章节 prompts数量:", prompts.length);
    const response = await this.call(prompts, onUpdate);
    return this.extractAllContents(response);
  }

  /**
   * 并发生成多个内容（一次调用，通用方法，保留兼容性）
   * @param prompts 多个不同的 prompt
   * @param onUpdate 流式更新回调
   */
  async batchGenerate(
    prompts: string[],
    onUpdate?: (index: number, content: string) => void,
  ): Promise<string[]> {
    const contents = prompts.map((msg) => `User：${msg}\nAssistant:`);
    const response = await this.call(contents, onUpdate);
    return this.extractAllContents(response);
  }

  /**
   * 自定义对话
   */
  async chat(
    message: string,
    _sessionId?: string,
    onUpdate?: (content: string) => void,
  ): Promise<string> {
    const prompt = `User：${message}\nAssistant:<think>`;
    const response = await this.call(
      [prompt],
      onUpdate ? (index, content) => onUpdate(content) : undefined,
    );

    return this.extractContent(response);
  }
}

// ========== 导出 ==========

// 创建默认实例
export const rwkvService = new RWKVService();

// 也可以导出类供用户创建自定义实例
export { RWKVService };

// 默认导出
export default rwkvService;
