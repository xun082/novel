import { RwkvDecodeConfig } from "@/lib/rwkv/rwkv-config";

export type NovelStage = "world" | "chapterPlan" | "paragraph" | "assembling";
export type NovelRunStatus = "pending" | "running" | "completed" | "failed";

export interface NovelRunInput {
  userIdea: string;
  novelCount: number;
  chapterCount: number;
  paragraphCount: number;
  batchSize: number;
  stylePreference?: string;
  genrePreference?: string;
  decodeConfig?: Partial<RwkvDecodeConfig>;
}

export interface NovelParagraphState {
  paragraphIndex: number;
  plan?: Record<string, unknown>;
  rawText?: string;
  content?: string;
  summary?: string;
  continuityNotes?: string[];
  nextParagraphHint?: string;
  error?: string;
}

export interface NovelChapterState {
  chapterIndex: number;
  chapterTitle: string;
  chapterPlanItem?: Record<string, unknown>;
  planRawText?: string;
  paragraphPlan?: Record<string, unknown>;
  paragraphs: NovelParagraphState[];
  chapterContent?: string;
  error?: string;
}

export interface NovelState {
  novelIndex: number;
  worldRawText?: string;
  world?: Record<string, unknown>;
  chapters: NovelChapterState[];
  fullNovelContent?: string;
  error?: string;
}

export interface NovelEvent {
  type: string;
  runId: string;
  payload?: Record<string, unknown>;
  ts: number;
}

export interface NovelRun {
  runId: string;
  status: NovelRunStatus;
  stage: NovelStage;
  input: NovelRunInput;
  novels: NovelState[];
  events: NovelEvent[];
  errors: string[];
  createdAt: number;
  updatedAt: number;
}

type EventListener = (event: NovelEvent) => void;

const novelRuns = new Map<string, NovelRun>();
const listeners = new Map<string, Set<EventListener>>();

export function createRun(input: NovelRunInput): NovelRun {
  const runId = `run_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  const now = Date.now();
  const run: NovelRun = {
    runId,
    status: "pending",
    stage: "world",
    input,
    novels: Array.from({ length: input.novelCount }, (_, i) => ({
      novelIndex: i,
      chapters: [],
    })),
    events: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
  };
  novelRuns.set(runId, run);
  publish(runId, "run.created", { input });
  return run;
}

export function getRun(runId: string): NovelRun | undefined {
  return novelRuns.get(runId);
}

export function updateRun(
  runId: string,
  mutator: (run: NovelRun) => void,
): NovelRun | undefined {
  const run = novelRuns.get(runId);
  if (!run) return undefined;
  mutator(run);
  run.updatedAt = Date.now();
  return run;
}

export function publish(
  runId: string,
  type: string,
  payload?: Record<string, unknown>,
): NovelEvent | undefined {
  const run = novelRuns.get(runId);
  if (!run) return undefined;
  const event: NovelEvent = { type, runId, payload, ts: Date.now() };
  // 历史事件保留上限，防止 events 列表无限增长（流式 chunk 会很多）。
  if (type !== "llm.chunk") run.events.push(event);
  run.updatedAt = event.ts;
  const subs = listeners.get(runId);
  if (subs) {
    for (const fn of subs) {
      try {
        fn(event);
      } catch {
        // ignore listener errors
      }
    }
  }
  return event;
}

export function subscribe(runId: string, fn: EventListener): () => void {
  let set = listeners.get(runId);
  if (!set) {
    set = new Set();
    listeners.set(runId, set);
  }
  set.add(fn);
  return () => {
    const cur = listeners.get(runId);
    if (!cur) return;
    cur.delete(fn);
    if (cur.size === 0) listeners.delete(runId);
  };
}

export function getNovel(
  run: NovelRun,
  novelIndex: number,
): NovelState | undefined {
  return run.novels.find((n) => n.novelIndex === novelIndex);
}

export function getChapter(
  novel: NovelState,
  chapterIndex: number,
): NovelChapterState | undefined {
  return novel.chapters.find((c) => c.chapterIndex === chapterIndex);
}

export function getParagraph(
  chapter: NovelChapterState,
  paragraphIndex: number,
): NovelParagraphState | undefined {
  return chapter.paragraphs.find((p) => p.paragraphIndex === paragraphIndex);
}
