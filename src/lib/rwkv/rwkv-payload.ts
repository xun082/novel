import { z } from "zod";
import type { ExpandTaskInput, ParagraphPromptInput } from "./rwkv-prompts";

/** 空串 → undefined（前端「上一段为空」常发空串，等价于「没有上一段」）。 */
const emptyToUndefined = (v: unknown) =>
  typeof v === "string" && v.trim() === "" ? undefined : v;

const chapterOutlineEntrySchema = z.object({
  title: z.string(),
  outline: z.string(),
});

const paragraphPromptInputSchema = z.object({
  novelTitle: z.string(),
  novelSummary: z.string(),
  worldbuildingText: z.string(),
  chapterTitle: z.string(),
  chapterOutline: z.string(),
  chapterNumber: z.number().int().positive(),
  totalChapters: z.number().int().positive(),
  paragraphNumber: z.number().int().positive(),
  totalParagraphs: z.number().int().positive(),
  paragraphOutline: z.string(),
  allChapterOutlines: z.array(chapterOutlineEntrySchema),
  previousParagraphContent: z.preprocess(emptyToUndefined, z.string().optional()),
  previousChapterContent: z.preprocess(emptyToUndefined, z.string().optional()),
});

const expandTaskInputSchema = paragraphPromptInputSchema.extend({
  currentContent: z.string(),
});

// 编译期断言：zod 推导出的输出类型必须严格等于上游 prompt builder 期望的入参。
// 一旦 rwkv-prompts.ts 的接口和 schema 漂移，这两个 const 会立刻红线。
const _checkParagraph: ParagraphPromptInput = {} as z.output<typeof paragraphPromptInputSchema>;
const _checkExpand: ExpandTaskInput = {} as z.output<typeof expandTaskInputSchema>;
void _checkParagraph;
void _checkExpand;

/** 用 zod schema 过滤数组：不是数组、单项校验失败都被丢弃，不抛错。 */
function filterParse<T extends z.ZodTypeAny>(
  raw: unknown,
  schema: T,
): z.output<T>[] {
  if (!Array.isArray(raw)) return [];
  const out: z.output<T>[] = [];
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (r.success) out.push(r.data);
  }
  return out;
}

/** POST /api/chapters 入参归一化。 */
export const normalizeChapters = (raw: unknown): ParagraphPromptInput[] =>
  filterParse(raw, paragraphPromptInputSchema);

/** POST /api/expand 入参归一化（额外要求 currentContent）。 */
export const normalizeExpandTasks = (raw: unknown): ExpandTaskInput[] =>
  filterParse(raw, expandTaskInputSchema);
