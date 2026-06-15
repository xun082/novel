import type { NovelChapter, NovelOutline, NovelParagraph, NovelWorldbuilding } from "@/lib/novel-data";

export const PARAGRAPHS_PER_CHAPTER = 3;
export const PARAGRAPH_EXPAND_MIN_CHARS = 180;
export const MAX_PARAGRAPH_EXPAND_ROUNDS = 3;

export type GenerationStage = "worldbuilding" | "paragraphs" | "expand" | "complete";

export interface ParagraphGenerationTask {
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
  allChapterOutlines: Array<{ title: string; outline: string }>;
  previousParagraphContent?: string;
  previousChapterContent?: string;
}

export interface ParagraphExpandTask extends ParagraphGenerationTask {
  currentContent: string;
}

const PENDING_MARKERS = ["生成中...", "扩写中...", "续写中", "写段中..."];

export const isStableText = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  return !PENDING_MARKERS.some((marker) => text.includes(marker) || text.startsWith(marker));
};

export const formatWorldbuilding = (worldbuilding: NovelWorldbuilding): string => {
  const characters = worldbuilding.characters
    .map(
      (character) =>
        `- ${character.name}（${character.role}）：${character.personality}；${character.background}`,
    )
    .join("\n");

  return `【故事背景】
${worldbuilding.setting || "（暂无）"}

【世界观规则】
${worldbuilding.rules || "（暂无）"}

【核心主题】
${worldbuilding.themes || "（暂无）"}

【主要人物】
${characters || "（暂无）"}`;
};

export const joinChapterParagraphs = (
  paragraphs: NovelParagraph[],
  prefer: "content" | "draft" = "content",
): string =>
  paragraphs
    .map((paragraph) => {
      if (prefer === "content") {
        return paragraph.content.trim() || paragraph.draft.trim();
      }
      return paragraph.draft.trim() || paragraph.content.trim();
    })
    .filter(Boolean)
    .join("\n\n");

export const syncChapterContent = (chapter: NovelChapter): string => {
  if (chapter.paragraphs.length > 0) {
    return joinChapterParagraphs(chapter.paragraphs);
  }
  return chapter.content;
};

export const emptyWorldbuilding = (): NovelWorldbuilding => ({
  setting: "",
  rules: "",
  themes: "",
  characters: [],
});

export const parseWorldbuilding = (
  jsonData: Record<string, unknown> | null,
): NovelWorldbuilding => {
  const raw = jsonData?.worldbuilding ?? jsonData?.世界观 ?? jsonData?.world;
  if (!raw || typeof raw !== "object") return emptyWorldbuilding();

  const source = raw as Record<string, unknown>;
  const characterRows = Array.isArray(source.characters)
    ? source.characters
    : Array.isArray(source.人物)
      ? source.人物
      : [];

  const characters = characterRows
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .map((row) => ({
      name:
        (typeof row.name === "string" && row.name) ||
        (typeof row.姓名 === "string" && row.姓名) ||
        "未命名",
      role:
        (typeof row.role === "string" && row.role) ||
        (typeof row.角色 === "string" && row.角色) ||
        "角色",
      personality:
        (typeof row.personality === "string" && row.personality) ||
        (typeof row.性格 === "string" && row.性格) ||
        "",
      background:
        (typeof row.background === "string" && row.background) ||
        (typeof row.背景 === "string" && row.背景) ||
        "",
    }));

  return {
    setting:
      (typeof source.setting === "string" && source.setting) ||
      (typeof source.故事背景 === "string" && source.故事背景) ||
      "",
    rules:
      (typeof source.rules === "string" && source.rules) ||
      (typeof source.世界观规则 === "string" && source.世界观规则) ||
      "",
    themes:
      (typeof source.themes === "string" && source.themes) ||
      (typeof source.核心主题 === "string" && source.核心主题) ||
      "",
    characters,
  };
};

export const parseParagraphRows = (
  chapterData: Record<string, unknown>,
  fallbackOutline: string,
): NovelParagraph[] => {
  const raw = chapterData.paragraphs ?? chapterData.段落;
  if (!Array.isArray(raw)) {
    return Array.from({ length: PARAGRAPHS_PER_CHAPTER }, (_, index) => ({
      id: index + 1,
      outline: fallbackOutline || "待生成",
      draft: "",
      content: "",
    }));
  }

  const parsed = raw
    .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
    .slice(0, PARAGRAPHS_PER_CHAPTER)
    .map((row, index) => ({
      id: index + 1,
      outline:
        (typeof row.outline === "string" && row.outline) ||
        (typeof row.梗概 === "string" && row.梗概) ||
        fallbackOutline ||
        "待生成",
      draft: "",
      content: "",
    }));

  while (parsed.length < PARAGRAPHS_PER_CHAPTER) {
    parsed.push({
      id: parsed.length + 1,
      outline: fallbackOutline || "待生成",
      draft: "",
      content: "",
    });
  }

  return parsed;
};

export const isParagraphDraftComplete = (draft: string): boolean => isStableText(draft);

export const isParagraphExpandComplete = (content: string): boolean =>
  isStableText(content) && content.trim().length >= PARAGRAPH_EXPAND_MIN_CHARS;

export const isChapterGenerationComplete = (chapter: NovelChapter): boolean => {
  if (!chapter.paragraphs.length) {
    return isStableText(chapter.content) && chapter.content.trim().length > 0;
  }
  return chapter.paragraphs.every((paragraph) => isParagraphExpandComplete(paragraph.content));
};

export const getGenerationStage = (outlines: NovelOutline[]): GenerationStage => {
  const hasStructuredOutlines = outlines.some(
    (outline) =>
      outline.chapters.length > 0 &&
      Boolean(outline.worldbuilding.setting.trim() || outline.summary.trim()),
  );
  if (!hasStructuredOutlines) return "worldbuilding";

  const needsParagraphDraft = outlines.some((outline) =>
    outline.chapters.some((chapter) =>
      chapter.paragraphs.some(
        (paragraph) =>
          paragraph.outline.trim() &&
          paragraph.outline !== "待生成" &&
          !isParagraphDraftComplete(paragraph.draft),
      ),
    ),
  );
  if (needsParagraphDraft) return "paragraphs";

  const needsExpand = outlines.some((outline) =>
    outline.chapters.some((chapter) =>
      chapter.paragraphs.some(
        (paragraph) =>
          isParagraphDraftComplete(paragraph.draft) &&
          !isParagraphExpandComplete(paragraph.content),
      ),
    ),
  );
  if (needsExpand) return "expand";

  const hasAnyOutput = outlines.some((outline) =>
    outline.chapters.some((chapter) => isChapterGenerationComplete(chapter)),
  );
  return hasAnyOutput ? "complete" : "worldbuilding";
};

export const buildParagraphGenerationTask = (
  outline: NovelOutline,
  chapterIndex: number,
  paragraphIndex: number,
  previousParagraphContent?: string,
  previousChapterContent?: string,
): ParagraphGenerationTask => {
  const chapter = outline.chapters[chapterIndex];
  const paragraph = chapter.paragraphs[paragraphIndex];

  return {
    novelTitle: outline.title,
    novelSummary: outline.summary,
    worldbuildingText: formatWorldbuilding(outline.worldbuilding),
    chapterTitle: chapter.title,
    chapterOutline: chapter.outline,
    chapterNumber: chapterIndex + 1,
    totalChapters: outline.chapters.length,
    paragraphNumber: paragraphIndex + 1,
    totalParagraphs: chapter.paragraphs.length,
    paragraphOutline: paragraph.outline,
    allChapterOutlines: outline.chapters.map((item) => ({
      title: item.title,
      outline: item.outline,
    })),
    previousParagraphContent,
    previousChapterContent,
  };
};

export const buildParagraphExpandTask = (
  outline: NovelOutline,
  chapterIndex: number,
  paragraphIndex: number,
  currentContent: string,
  previousParagraphContent?: string,
  previousChapterContent?: string,
): ParagraphExpandTask => ({
  ...buildParagraphGenerationTask(
    outline,
    chapterIndex,
    paragraphIndex,
    previousParagraphContent,
    previousChapterContent,
  ),
  currentContent,
});
