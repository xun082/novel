import { wrapJsonPrompt } from "@/lib/rwkv/rwkv-config";

export interface WorldPromptInput {
  userIdea: string;
  novelIndex: number;
  novelCount: number;
  chapterCount: number;
  genrePreference?: string;
  stylePreference?: string;
}

export function buildNovelWorldPrompt(input: WorldPromptInput): string {
  const userContent = `你是专业小说策划师。请基于用户创意生成第 ${input.novelIndex + 1} 本小说的世界观方案。

用户创意：
${input.userIdea}

偏好类型：
${input.genrePreference ?? "不限"}

风格偏好：
${input.stylePreference ?? "自然、有画面感、适合连续章节扩写"}

本次会并发生成 ${input.novelCount} 本不同小说。你只负责当前这一本。
请让当前方案和其他可能方案有明显差异，不要写成通用模板。

章节数量：
${input.chapterCount}

生成要求：
- 只输出 JSON
- 不要输出解释
- 不要写正文
- 世界观、人物关系、核心冲突要清楚
- chapterPlan 必须正好包含 ${input.chapterCount} 章
- chapterIndex 从 1 开始
- 每章要能支撑后续生成段落规划

返回 JSON 结构：
{
  "novelTitle": "小说标题",
  "genre": "小说类型",
  "tone": "整体基调",
  "coreHook": "一句话核心看点",
  "worldview": "世界观设定",
  "background": "故事背景",
  "mainCharacters": [
    {
      "name": "人物姓名",
      "role": "人物身份",
      "personality": "人物性格",
      "motivation": "人物目标或动机"
    }
  ],
  "relationships": "主要人物关系",
  "conflict": "核心冲突",
  "chapterPlan": [
    {
      "chapterIndex": 1,
      "chapterTitle": "章节标题",
      "chapterGoal": "本章要完成的剧情目标",
      "keyEvents": ["关键事件1", "关键事件2"],
      "endingHook": "本章结尾留下的悬念或承接点"
    }
  ]
}`;
  return wrapJsonPrompt(userContent);
}

export interface ChapterParagraphPlanPromptInput {
  novelWorld: Record<string, unknown>;
  chapter: Record<string, unknown>;
  paragraphCount: number;
}

export function buildChapterParagraphPlanPrompt(
  input: ChapterParagraphPlanPromptInput,
): string {
  const worldSlim = {
    novelTitle: input.novelWorld.novelTitle,
    genre: input.novelWorld.genre,
    tone: input.novelWorld.tone,
    coreHook: input.novelWorld.coreHook,
    worldview: input.novelWorld.worldview,
    background: input.novelWorld.background,
    mainCharacters: input.novelWorld.mainCharacters,
    relationships: input.novelWorld.relationships,
    conflict: input.novelWorld.conflict,
  };
  const userContent = `你是小说章节结构设计师。请为当前章节生成段落规划。

注意：
你只规划当前这一章，不要写正文。
这些段落会在下一轮被逐段扩写，所以每个段落都要足够具体。

小说信息：
${JSON.stringify(worldSlim)}

当前章节：
${JSON.stringify(input.chapter)}

段落数量：
${input.paragraphCount}

生成要求：
- 只输出 JSON
- 不要输出解释
- 不要写正文
- paragraphs 必须正好包含 ${input.paragraphCount} 个段落
- paragraphIndex 从 1 开始
- 每个段落要有明确目标、场景、人物、动作、情绪和过渡
- 段落之间要连续，不要互相割裂
- requiredDetails 要具体，方便下一轮直接扩写

返回 JSON 结构：
{
  "novelTitle": "${String(input.novelWorld.novelTitle ?? "")}",
  "chapterIndex": ${Number((input.chapter as { chapterIndex?: number }).chapterIndex ?? 1)},
  "chapterTitle": "${String((input.chapter as { chapterTitle?: string }).chapterTitle ?? "")}",
  "chapterGoal": "${String((input.chapter as { chapterGoal?: string }).chapterGoal ?? "")}",
  "paragraphs": [
    {
      "paragraphIndex": 1,
      "paragraphGoal": "当前段落目标",
      "pov": "叙事视角",
      "scene": "场景",
      "charactersInScene": ["人物A"],
      "keyAction": "关键动作",
      "emotion": "情绪",
      "requiredDetails": ["必须写到的细节1", "必须写到的细节2"],
      "transitionToNext": "如何过渡到下一段"
    }
  ]
}`;
  return wrapJsonPrompt(userContent);
}

export interface ExpandParagraphPromptInput {
  novelWorld: Record<string, unknown>;
  chapter: Record<string, unknown>;
  paragraphPlan: Record<string, unknown>;
  previousParagraphContent?: string;
  previousParagraphSummary?: string;
  stylePreference?: string;
}

export function buildExpandParagraphPrompt(
  input: ExpandParagraphPromptInput,
): string {
  const worldSlim = {
    novelTitle: input.novelWorld.novelTitle,
    genre: input.novelWorld.genre,
    tone: input.novelWorld.tone,
    worldview: input.novelWorld.worldview,
    background: input.novelWorld.background,
    mainCharacters: input.novelWorld.mainCharacters,
    conflict: input.novelWorld.conflict,
  };
  const chapterSlim = {
    chapterIndex: (input.chapter as { chapterIndex?: number }).chapterIndex,
    chapterTitle: (input.chapter as { chapterTitle?: string }).chapterTitle,
    chapterGoal: (input.chapter as { chapterGoal?: string }).chapterGoal,
  };
  const userContent = `你是小说正文写作者。请只扩写当前这一个段落。

小说背景：
${JSON.stringify(worldSlim)}

当前章节：
${JSON.stringify(chapterSlim)}

当前段落规划：
${JSON.stringify(input.paragraphPlan)}

上一段正文：
${input.previousParagraphContent ?? "这是本章第一段，暂无上一段正文"}

上一段摘要：
${input.previousParagraphSummary ?? "暂无上一段摘要"}

写作风格：
${input.stylePreference ?? "自然、有画面感、有连续性，不要像大纲，不要过度解释设定"}

生成要求：
- 只输出 JSON
- 不要输出解释
- 只写当前段落，不要写整章
- 不要重复上一段
- 不要提前写后面段落的关键事件
- content 必须是可以直接拼接进小说正文的自然文本
- content 要承接上一段正文
- content 要完成当前 paragraphGoal
- summary 用一句话概括当前段落
- continuityNotes 记录本段新增状态、伏笔、人物变化或设定变化
- nextParagraphHint 给下一段承接使用
- paragraphIndex 必须等于当前段落规划里的 paragraphIndex

返回 JSON 结构：
{
  "paragraphIndex": ${Number((input.paragraphPlan as { paragraphIndex?: number }).paragraphIndex ?? 1)},
  "content": "当前段落正文",
  "summary": "当前段落摘要",
  "continuityNotes": ["连续性记录1", "连续性记录2"],
  "nextParagraphHint": "下一段承接提示"
}`;
  return wrapJsonPrompt(userContent);
}
