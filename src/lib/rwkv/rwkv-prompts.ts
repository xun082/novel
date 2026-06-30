// =============== Prompt builders (outline / paragraph / expand) ===============
//
// 输入数据由调用方（route → rwkv-payload zod 校验）保证类型正确。本文件不再 trim、
// 不再用占位符兜底缺失字段：空字段就写空——LLM 看到空字段自然忽略；用「（未定书名）」
// 这种伪信号反而会误导模型当成真有这么个内容。可选段落（上一章 / 上一段）缺省时整块省略。

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

const JSON_FENCE_OPEN = "```json\n";
const ASSISTANT_PRELUDE_OUTLINE = "Assistant: <think>\n</think>\n";
const ASSISTANT_PRELUDE_BODY = "Assistant: ";

const PREVIOUS_TEXT_MAX_CHARS = 1200;

const OUTLINE_JSON_EXAMPLE = `{
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

export interface ExpandTaskInput extends ParagraphPromptInput {
  currentContent: string;
}

const renderChapterOutlineList = (entries: ChapterOutlineEntry[]): string =>
  entries
    .map((e, i) => `第${i + 1}章 ${e.title}：${e.outline}`)
    .join("\n");

const tailTruncate = (s: string): string =>
  s.length <= PREVIOUS_TEXT_MAX_CHARS ? s : `…${s.slice(-PREVIOUS_TEXT_MAX_CHARS)}`;

const renderContextBlock = (t: ParagraphPromptInput): string => {
  const parts = [
    `【全书设定】\n书名：${t.novelTitle}\n梗概：${t.novelSummary}\n\n${t.worldbuildingText}`,
  ];
  if (t.allChapterOutlines.length > 0)
    parts.push(`【各章梗概】\n${renderChapterOutlineList(t.allChapterOutlines)}`);
  if (t.previousChapterContent)
    parts.push(`【上一章正文】\n${tailTruncate(t.previousChapterContent)}`);
  if (t.previousParagraphContent)
    parts.push(`【本章已写段落】\n${tailTruncate(t.previousParagraphContent)}`);
  return parts.join("\n\n");
};

const renderTaskHeader = (t: ParagraphPromptInput): string =>
  `第${t.chapterNumber}章（共${t.totalChapters}章）${t.chapterTitle} —— 第${t.paragraphNumber}/${t.totalParagraphs}段\n段落要点：${t.paragraphOutline}`;

/** 第一轮：生成多份小说大纲（含世界观）。 */
export const buildOutlinePrompts = (
  genre: string,
  chapters: number,
  count: number,
): string[] =>
  Array.from({ length: count }, (_, index) => {
    const style = OUTLINE_STYLES[index % OUTLINE_STYLES.length];
    const batchNo = Math.floor(index / OUTLINE_STYLES.length) + 1;
    const extra =
      batchNo > 1
        ? `补充要求：与同风格方案保持显著差异，重点突出第${batchNo}套创意路线。\n\n`
        : "";
    return `User: 设计一份完整的[${genre}]小说世界观与大纲，共${chapters}章。要求风格：${style}。

这是第一轮：请输出完整世界观设定（故事背景、人物信息、世界观规则）和章节结构。每章必须拆分为3个段落要点。

请以JSON格式输出，格式如下：
${OUTLINE_JSON_EXAMPLE}

要求：
1. title要有吸引力
2. summary要详细（100-200字）
3. worldbuilding必须完整：setting/rules/themes/characters（至少3个主要人物）
4. chapters数组包含${chapters}个章节
5. 每章outline要详细（50-100字）
6. 每章paragraphs必须恰好3个，每个outline写清该段情节要点
7. 保持整体节奏统一，主线清晰，人物设定前后一致

${extra}直接输出JSON，不要其他说明。

${ASSISTANT_PRELUDE_OUTLINE}${JSON_FENCE_OPEN}`;
  });

/** 第二轮：只生成当前段落草稿（80-120字）。 */
export const buildChapterPrompts = (tasks: ParagraphPromptInput[]): string[] =>
  tasks.map((t) => `User: 你是专业小说作家。这是第二轮：只写当前段落的草稿，80-120字，不要写其他段落。

${renderContextBlock(t)}

【当前段落任务】
${renderTaskHeader(t)}

要求：
1. 只输出当前这一段，紧接上文自然起笔
2. 人物性格、称谓与世界观保持一致
3. 仅输出 JSON：{"content":"..."}

${ASSISTANT_PRELUDE_BODY}${JSON_FENCE_OPEN}`);

/** 第三轮：扩写当前段落，单次扩写；前端可重复调用直到达标。 */
export const buildExpandPrompts = (tasks: ExpandTaskInput[]): string[] =>
  tasks.map((t) => `User: 你是专业小说作家。这是第三轮：扩写下面这一段到 200-300 字，只输出当前段落。

${renderContextBlock(t)}

【当前段落任务】
${renderTaskHeader(t)}

【待扩写段落草稿】
${t.currentContent}

要求：
1. 保留草稿核心情节，补充细节、动作与心理描写
2. 不要改动人设，不要写到其他段落
3. 仅输出 JSON：{"content":"..."}

${ASSISTANT_PRELUDE_BODY}${JSON_FENCE_OPEN}`);
