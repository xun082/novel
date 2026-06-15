import {
  BatchTarget,
  rwkvBatchCompletion,
} from "@/lib/rwkv/rwkv-batch-client";
import { parseJsonFromRaw } from "@/lib/rwkv/rwkv-json";
import {
  buildChapterParagraphPlanPrompt,
  buildExpandParagraphPrompt,
  buildNovelWorldPrompt,
} from "./novel-prompts";
import {
  NovelChapterState,
  NovelParagraphState,
  NovelRun,
  NovelStage,
  getChapter,
  getNovel,
  getParagraph,
  getRun,
  publish,
  updateRun,
} from "./novel-store";

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

function setStage(runId: string, stage: NovelStage) {
  updateRun(runId, (run) => {
    run.stage = stage;
    if (run.status === "pending") run.status = "running";
  });
  publish(runId, "stage.started", { stage });
}

function emitChunk(
  runId: string,
  stage: NovelStage,
  target: BatchTarget,
  delta: string,
  buffer: string,
) {
  publish(runId, "llm.chunk", {
    stage,
    novelIndex: target.novelIndex,
    chapterIndex: target.chapterIndex,
    paragraphIndex: target.paragraphIndex,
    delta,
    bufferLength: buffer.length,
  });
}

function emitProgress(
  runId: string,
  stage: NovelStage,
  done: number,
  total: number,
) {
  publish(runId, "progress.updated", { stage, done, total });
}

export async function runNovelWorkflow(runId: string): Promise<void> {
  const run = getRun(runId);
  if (!run) return;

  try {
    await runWorldStage(run);
    await runChapterPlanStage(run);
    await runParagraphStage(run);
    assembleAll(run);

    updateRun(run.runId, (r) => {
      r.status = "completed";
      r.stage = "assembling";
    });
    publish(run.runId, "run.completed", {
      novels: run.novels.map((n) => ({
        novelIndex: n.novelIndex,
        novelTitle: (n.world as { novelTitle?: string } | undefined)?.novelTitle,
        hasContent: Boolean(n.fullNovelContent),
        error: n.error,
      })),
    });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    updateRun(run.runId, (r) => {
      r.status = "failed";
      r.errors.push(message);
    });
    publish(run.runId, "run.failed", { error: message });
  }
}

/** 第一轮：并发生成多本小说的世界观和章节计划。 */
async function runWorldStage(run: NovelRun): Promise<void> {
  setStage(run.runId, "world");

  const {
    userIdea,
    novelCount,
    chapterCount,
    genrePreference,
    stylePreference,
    decodeConfig,
  } = run.input;

  const contents = Array.from({ length: novelCount }, (_, novelIndex) =>
    buildNovelWorldPrompt({
      userIdea,
      novelIndex,
      novelCount,
      chapterCount,
      genrePreference,
      stylePreference,
    }),
  );
  const targets: BatchTarget[] = contents.map((_, novelIndex) => ({
    novelIndex,
  }));

  let done = 0;
  const results = await rwkvBatchCompletion({
    contents,
    targets,
    decodeConfig,
    onChunk: ({ target, delta, buffer }) =>
      emitChunk(run.runId, "world", target, delta, buffer),
  });

  for (const r of results) {
    const novel = getNovel(run, r.target.novelIndex);
    if (!novel) continue;
    novel.worldRawText = r.rawText;
    const parsed = parseJsonFromRaw<Record<string, unknown>>(r.rawText);
    if (
      parsed.parsed &&
      typeof parsed.parsed.novelTitle === "string" &&
      Array.isArray(parsed.parsed.chapterPlan)
    ) {
      novel.world = parsed.parsed;
      const plan = parsed.parsed.chapterPlan as Array<Record<string, unknown>>;
      novel.chapters = plan.map((item, i) => ({
        chapterIndex:
          typeof item.chapterIndex === "number" ? item.chapterIndex : i + 1,
        chapterTitle:
          typeof item.chapterTitle === "string"
            ? item.chapterTitle
            : `第${i + 1}章`,
        chapterPlanItem: item,
        paragraphs: [],
      }));
      publish(run.runId, "item.completed", {
        stage: "world",
        novelIndex: novel.novelIndex,
        novelTitle: parsed.parsed.novelTitle,
      });
    } else {
      novel.error = parsed.error ?? "world_parse_failed";
      publish(run.runId, "item.failed", {
        stage: "world",
        novelIndex: novel.novelIndex,
        error: novel.error,
        rawTextPreview: r.rawText.slice(0, 200),
      });
    }
    done += 1;
    emitProgress(run.runId, "world", done, results.length);
  }
}

/** 第二轮：为每章生成段落规划。 */
async function runChapterPlanStage(run: NovelRun): Promise<void> {
  setStage(run.runId, "chapterPlan");

  interface Task {
    content: string;
    target: BatchTarget;
  }
  const tasks: Task[] = [];

  for (const novel of run.novels) {
    if (!novel.world || novel.error) continue;
    for (const chapter of novel.chapters) {
      tasks.push({
        content: buildChapterParagraphPlanPrompt({
          novelWorld: novel.world,
          chapter: chapter.chapterPlanItem ?? {
            chapterIndex: chapter.chapterIndex,
            chapterTitle: chapter.chapterTitle,
          },
          paragraphCount: run.input.paragraphCount,
        }),
        target: {
          novelIndex: novel.novelIndex,
          chapterIndex: chapter.chapterIndex,
        },
      });
    }
  }

  if (tasks.length === 0) return;

  const batches = chunkArray(tasks, Math.max(1, run.input.batchSize));
  let done = 0;
  const totalTasks = tasks.length;

  for (const batch of batches) {
    const results = await rwkvBatchCompletion({
      contents: batch.map((t) => t.content),
      targets: batch.map((t) => t.target),
      decodeConfig: run.input.decodeConfig,
      onChunk: ({ target, delta, buffer }) =>
        emitChunk(run.runId, "chapterPlan", target, delta, buffer),
    });

    for (const r of results) {
      const { novelIndex, chapterIndex } = r.target;
      if (chapterIndex === undefined) continue;
      const novel = getNovel(run, novelIndex);
      if (!novel) continue;
      const chapter = getChapter(novel, chapterIndex);
      if (!chapter) continue;

      chapter.planRawText = r.rawText;
      const parsed = parseJsonFromRaw<Record<string, unknown>>(r.rawText);
      if (parsed.parsed && Array.isArray(parsed.parsed.paragraphs)) {
        chapter.paragraphPlan = parsed.parsed;
        const ps = parsed.parsed.paragraphs as Array<Record<string, unknown>>;
        chapter.paragraphs = ps.map((p, i) => ({
          paragraphIndex:
            typeof p.paragraphIndex === "number" ? p.paragraphIndex : i + 1,
          plan: p,
        }));
        publish(run.runId, "item.completed", {
          stage: "chapterPlan",
          novelIndex,
          chapterIndex,
          paragraphCount: chapter.paragraphs.length,
        });
      } else {
        chapter.error = parsed.error ?? "chapter_plan_parse_failed";
        publish(run.runId, "item.failed", {
          stage: "chapterPlan",
          novelIndex,
          chapterIndex,
          error: chapter.error,
          rawTextPreview: r.rawText.slice(0, 200),
        });
      }
      done += 1;
      emitProgress(run.runId, "chapterPlan", done, totalTasks);
    }
  }
}

/** 第三轮：每段独立扩写。 */
async function runParagraphStage(run: NovelRun): Promise<void> {
  setStage(run.runId, "paragraph");

  interface Task {
    content: string;
    target: BatchTarget;
  }
  const tasks: Task[] = [];

  for (const novel of run.novels) {
    if (!novel.world || novel.error) continue;
    for (const chapter of novel.chapters) {
      if (chapter.error || !chapter.paragraphPlan) continue;
      for (const paragraph of chapter.paragraphs) {
        tasks.push({
          content: buildExpandParagraphPrompt({
            novelWorld: novel.world,
            chapter: chapter.chapterPlanItem ?? {
              chapterIndex: chapter.chapterIndex,
              chapterTitle: chapter.chapterTitle,
            },
            paragraphPlan: paragraph.plan ?? {
              paragraphIndex: paragraph.paragraphIndex,
            },
            stylePreference: run.input.stylePreference,
          }),
          target: {
            novelIndex: novel.novelIndex,
            chapterIndex: chapter.chapterIndex,
            paragraphIndex: paragraph.paragraphIndex,
          },
        });
      }
    }
  }

  if (tasks.length === 0) return;

  const batches = chunkArray(tasks, Math.max(1, run.input.batchSize));
  let done = 0;
  const totalTasks = tasks.length;

  for (const batch of batches) {
    const results = await rwkvBatchCompletion({
      contents: batch.map((t) => t.content),
      targets: batch.map((t) => t.target),
      decodeConfig: run.input.decodeConfig,
      onChunk: ({ target, delta, buffer }) =>
        emitChunk(run.runId, "paragraph", target, delta, buffer),
    });

    for (const r of results) {
      applyParagraphResult(run, r.target, r.rawText);
      done += 1;
      emitProgress(run.runId, "paragraph", done, totalTasks);
    }
  }
}

function applyParagraphResult(
  run: NovelRun,
  target: BatchTarget,
  rawText: string,
): NovelParagraphState | undefined {
  const { novelIndex, chapterIndex, paragraphIndex } = target;
  if (chapterIndex === undefined || paragraphIndex === undefined) return;
  const novel = getNovel(run, novelIndex);
  if (!novel) return;
  const chapter = getChapter(novel, chapterIndex);
  if (!chapter) return;
  const paragraph = getParagraph(chapter, paragraphIndex);
  if (!paragraph) return;

  paragraph.rawText = rawText;
  paragraph.error = undefined;
  const parsed = parseJsonFromRaw<Record<string, unknown>>(rawText);
  if (parsed.parsed && typeof parsed.parsed.content === "string") {
    paragraph.content = parsed.parsed.content;
    paragraph.summary =
      typeof parsed.parsed.summary === "string"
        ? parsed.parsed.summary
        : undefined;
    paragraph.continuityNotes = Array.isArray(parsed.parsed.continuityNotes)
      ? (parsed.parsed.continuityNotes as string[])
      : undefined;
    paragraph.nextParagraphHint =
      typeof parsed.parsed.nextParagraphHint === "string"
        ? parsed.parsed.nextParagraphHint
        : undefined;
    publish(run.runId, "item.completed", {
      stage: "paragraph",
      novelIndex,
      chapterIndex,
      paragraphIndex,
      contentLength: paragraph.content.length,
    });
  } else {
    paragraph.error = parsed.error ?? "paragraph_parse_failed";
    publish(run.runId, "item.failed", {
      stage: "paragraph",
      novelIndex,
      chapterIndex,
      paragraphIndex,
      error: paragraph.error,
      rawTextPreview: rawText.slice(0, 200),
    });
  }
  return paragraph;
}

function assembleChapter(chapter: NovelChapterState): void {
  chapter.chapterContent = chapter.paragraphs
    .slice()
    .sort((a, b) => a.paragraphIndex - b.paragraphIndex)
    .map((p) => p.content)
    .filter((c): c is string => Boolean(c))
    .join("\n\n");
}

function assembleAll(run: NovelRun): void {
  setStage(run.runId, "assembling");
  for (const novel of run.novels) {
    if (!novel.world || novel.error) continue;
    for (const chapter of novel.chapters) {
      assembleChapter(chapter);
    }
    novel.fullNovelContent = novel.chapters
      .slice()
      .sort((a, b) => a.chapterIndex - b.chapterIndex)
      .map(
        (c) =>
          `# ${c.chapterTitle}\n\n${c.chapterContent ?? ""}`,
      )
      .join("\n\n");
  }
}

/** 重试单个段落：单条 batch completion。 */
export async function retryParagraph(
  runId: string,
  novelIndex: number,
  chapterIndex: number,
  paragraphIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  const run = getRun(runId);
  if (!run) return { ok: false, error: "run_not_found" };
  const novel = getNovel(run, novelIndex);
  if (!novel || !novel.world)
    return { ok: false, error: "novel_not_ready" };
  const chapter = getChapter(novel, chapterIndex);
  if (!chapter || !chapter.paragraphPlan)
    return { ok: false, error: "chapter_not_ready" };
  const paragraph = getParagraph(chapter, paragraphIndex);
  if (!paragraph) return { ok: false, error: "paragraph_not_found" };

  const content = buildExpandParagraphPrompt({
    novelWorld: novel.world,
    chapter: chapter.chapterPlanItem ?? {
      chapterIndex: chapter.chapterIndex,
      chapterTitle: chapter.chapterTitle,
    },
    paragraphPlan: paragraph.plan ?? { paragraphIndex },
    stylePreference: run.input.stylePreference,
  });
  const target: BatchTarget = {
    novelIndex,
    chapterIndex,
    paragraphIndex,
  };

  try {
    const results = await rwkvBatchCompletion({
      contents: [content],
      targets: [target],
      decodeConfig: run.input.decodeConfig,
      onChunk: ({ target: t, delta, buffer }) =>
        emitChunk(run.runId, "paragraph", t, delta, buffer),
    });
    const r = results[0];
    if (!r) return { ok: false, error: "no_result" };
    applyParagraphResult(run, target, r.rawText);
    assembleChapter(chapter);
    return { ok: !paragraph.error, error: paragraph.error };
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    paragraph.error = message;
    publish(run.runId, "item.failed", {
      stage: "paragraph",
      novelIndex,
      chapterIndex,
      paragraphIndex,
      error: message,
    });
    return { ok: false, error: message };
  }
}
