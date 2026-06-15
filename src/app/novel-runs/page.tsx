"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

interface ParagraphView {
  paragraphIndex: number;
  plan?: Record<string, unknown>;
  content?: string;
  summary?: string;
  rawText?: string;
  error?: string;
  streamingBuffer?: string;
  streamingLength?: number;
}

interface ChapterView {
  chapterIndex: number;
  chapterTitle: string;
  paragraphPlan?: Record<string, unknown>;
  paragraphs: ParagraphView[];
  chapterContent?: string;
  planRawText?: string;
  error?: string;
  streamingBuffer?: string;
}

interface NovelView {
  novelIndex: number;
  world?: Record<string, unknown>;
  worldRawText?: string;
  chapters: ChapterView[];
  fullNovelContent?: string;
  error?: string;
  streamingBuffer?: string;
}

interface RunState {
  runId: string;
  status: string;
  stage: string;
  novels: NovelView[];
  progress: Record<string, { done: number; total: number }>;
  finalError?: string;
}

interface SseEvent {
  type: string;
  runId: string;
  payload?: Record<string, unknown>;
  ts: number;
}

function findNovel(novels: NovelView[], idx: number): NovelView | undefined {
  return novels.find((n) => n.novelIndex === idx);
}
function findChapter(
  novel: NovelView | undefined,
  idx: number,
): ChapterView | undefined {
  return novel?.chapters.find((c) => c.chapterIndex === idx);
}
function findParagraph(
  chapter: ChapterView | undefined,
  idx: number,
): ParagraphView | undefined {
  return chapter?.paragraphs.find((p) => p.paragraphIndex === idx);
}

export default function NovelRunsPage() {
  const [userIdea, setUserIdea] = useState(
    "都市修真：主角是外卖骑手，意外得到能短时间观察人物运势的能力。",
  );
  const [novelCount, setNovelCount] = useState(2);
  const [chapterCount, setChapterCount] = useState(2);
  const [paragraphCount, setParagraphCount] = useState(3);
  const [batchSize, setBatchSize] = useState(6);
  const [stylePreference, setStylePreference] = useState(
    "自然、有画面感，连续性强",
  );
  const [genrePreference, setGenrePreference] = useState("都市玄幻");

  const [runState, setRunState] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const applyEvent = useCallback((event: SseEvent) => {
    setRunState((prev) => {
      const base: RunState = prev ?? {
        runId: event.runId,
        status: "running",
        stage: "world",
        novels: [],
        progress: {},
      };

      const next: RunState = {
        ...base,
        progress: { ...base.progress },
        novels: base.novels.map((n) => ({
          ...n,
          chapters: n.chapters.map((c) => ({
            ...c,
            paragraphs: c.paragraphs.map((p) => ({ ...p })),
          })),
        })),
      };

      const p = event.payload ?? {};

      switch (event.type) {
        case "run.snapshot": {
          const novels = (p.novels as NovelView[] | undefined) ?? [];
          next.status = (p.status as string) ?? next.status;
          next.stage = (p.stage as string) ?? next.stage;
          next.novels = novels.map((n) => ({
            novelIndex: n.novelIndex,
            world: n.world,
            worldRawText: n.worldRawText,
            error: n.error,
            fullNovelContent: n.fullNovelContent,
            chapters: (n.chapters ?? []).map((c) => ({
              chapterIndex: c.chapterIndex,
              chapterTitle: c.chapterTitle,
              paragraphPlan: c.paragraphPlan,
              planRawText: c.planRawText,
              chapterContent: c.chapterContent,
              error: c.error,
              paragraphs: (c.paragraphs ?? []).map((pp) => ({
                paragraphIndex: pp.paragraphIndex,
                plan: pp.plan,
                content: pp.content,
                summary: pp.summary,
                rawText: pp.rawText,
                error: pp.error,
              })),
            })),
          }));
          break;
        }
        case "run.created": {
          next.status = "running";
          break;
        }
        case "stage.started": {
          next.stage = (p.stage as string) ?? next.stage;
          break;
        }
        case "progress.updated": {
          const stage = (p.stage as string) ?? next.stage;
          next.progress[stage] = {
            done: Number(p.done) || 0,
            total: Number(p.total) || 0,
          };
          break;
        }
        case "llm.chunk": {
          const stage = p.stage as string;
          const novelIndex = Number(p.novelIndex);
          const chapterIndex =
            p.chapterIndex !== undefined ? Number(p.chapterIndex) : undefined;
          const paragraphIndex =
            p.paragraphIndex !== undefined
              ? Number(p.paragraphIndex)
              : undefined;
          const bufferLength = Number(p.bufferLength) || 0;
          const delta = String(p.delta ?? "");

          let novel = findNovel(next.novels, novelIndex);
          if (!novel) {
            novel = { novelIndex, chapters: [] };
            next.novels.push(novel);
          }
          if (stage === "world") {
            novel.streamingBuffer = (novel.streamingBuffer ?? "") + delta;
            break;
          }
          if (chapterIndex === undefined) break;
          let chapter = findChapter(novel, chapterIndex);
          if (!chapter) {
            chapter = {
              chapterIndex,
              chapterTitle: `第${chapterIndex}章`,
              paragraphs: [],
            };
            novel.chapters.push(chapter);
          }
          if (stage === "chapterPlan") {
            chapter.streamingBuffer = (chapter.streamingBuffer ?? "") + delta;
            break;
          }
          if (stage === "paragraph" && paragraphIndex !== undefined) {
            let paragraph = findParagraph(chapter, paragraphIndex);
            if (!paragraph) {
              paragraph = { paragraphIndex };
              chapter.paragraphs.push(paragraph);
            }
            paragraph.streamingBuffer =
              (paragraph.streamingBuffer ?? "") + delta;
            paragraph.streamingLength = bufferLength;
          }
          break;
        }
        case "item.completed": {
          const stage = p.stage as string;
          const novelIndex = Number(p.novelIndex);
          const novel = findNovel(next.novels, novelIndex);
          if (!novel) break;
          if (stage === "world") {
            novel.streamingBuffer = undefined;
          } else if (stage === "chapterPlan") {
            const chapter = findChapter(novel, Number(p.chapterIndex));
            if (chapter) chapter.streamingBuffer = undefined;
          } else if (stage === "paragraph") {
            const chapter = findChapter(novel, Number(p.chapterIndex));
            const paragraph = findParagraph(chapter, Number(p.paragraphIndex));
            if (paragraph) {
              paragraph.streamingBuffer = undefined;
            }
          }
          break;
        }
        case "item.failed": {
          const stage = p.stage as string;
          const novel = findNovel(next.novels, Number(p.novelIndex));
          if (!novel) break;
          if (stage === "world") {
            novel.error = String(p.error ?? "world_failed");
          } else if (stage === "chapterPlan") {
            const chapter = findChapter(novel, Number(p.chapterIndex));
            if (chapter) chapter.error = String(p.error ?? "chapter_failed");
          } else if (stage === "paragraph") {
            const chapter = findChapter(novel, Number(p.chapterIndex));
            const paragraph = findParagraph(chapter, Number(p.paragraphIndex));
            if (paragraph) paragraph.error = String(p.error ?? "paragraph_failed");
          }
          break;
        }
        case "run.completed": {
          next.status = "completed";
          break;
        }
        case "run.failed": {
          next.status = "failed";
          next.finalError = String(p.error ?? "");
          break;
        }
      }
      return next;
    });
  }, []);

  const startRun = useCallback(async () => {
    setStarting(true);
    try {
      esRef.current?.close();
      esRef.current = null;
      const res = await fetch("/api/novel-runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userIdea,
          novelCount,
          chapterCount,
          paragraphCount,
          batchSize,
          stylePreference,
          genrePreference,
        }),
      });
      const data = (await res.json()) as { runId?: string; error?: string };
      if (!data.runId) {
        alert(`创建失败: ${data.error ?? res.statusText}`);
        return;
      }
      setRunState({
        runId: data.runId,
        status: "running",
        stage: "world",
        novels: Array.from({ length: novelCount }, (_, i) => ({
          novelIndex: i,
          chapters: [],
        })),
        progress: {},
      });

      const es = new EventSource(`/api/novel-runs/${data.runId}/events`);
      esRef.current = es;
      const handle = (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data) as SseEvent;
          applyEvent(parsed);
        } catch {
          // ignore
        }
      };
      for (const t of [
        "run.created",
        "run.snapshot",
        "stage.started",
        "llm.chunk",
        "item.completed",
        "item.failed",
        "progress.updated",
        "run.completed",
        "run.failed",
      ]) {
        es.addEventListener(t, handle as EventListener);
      }
      es.onerror = () => {
        // 服务端关闭连接时也会触发
      };
    } finally {
      setStarting(false);
    }
  }, [
    applyEvent,
    batchSize,
    chapterCount,
    genrePreference,
    novelCount,
    paragraphCount,
    stylePreference,
    userIdea,
  ]);

  useEffect(() => {
    return () => {
      esRef.current?.close();
      esRef.current = null;
    };
  }, []);

  const retry = useCallback(
    async (
      novelIndex: number,
      chapterIndex: number,
      paragraphIndex: number,
    ) => {
      if (!runState) return;
      const key = `${novelIndex}/${chapterIndex}/${paragraphIndex}`;
      setRetrying(key);
      try {
        await fetch(
          `/api/novel-runs/${runState.runId}/retry-paragraph`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              novelIndex,
              chapterIndex,
              paragraphIndex,
            }),
          },
        );
      } finally {
        setRetrying(null);
      }
    },
    [runState],
  );

  const progressLine = useMemo(() => {
    if (!runState) return "";
    return Object.entries(runState.progress)
      .map(([stage, p]) => `${stage}:${p.done}/${p.total}`)
      .join("  ");
  }, [runState]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        <h1 className="text-2xl font-bold">并发小说生成测试</h1>

        <section className="space-y-3 bg-zinc-900 border border-zinc-800 rounded p-4">
          <label className="block text-sm">
            <span className="text-zinc-400">小说创意 userIdea</span>
            <textarea
              className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2 text-sm"
              rows={3}
              value={userIdea}
              onChange={(e) => setUserIdea(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
            <label>
              <span className="text-zinc-400">小说数 novelCount</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
                value={novelCount}
                min={1}
                onChange={(e) => setNovelCount(Number(e.target.value) || 1)}
              />
            </label>
            <label>
              <span className="text-zinc-400">章节数 chapterCount</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
                value={chapterCount}
                min={1}
                onChange={(e) => setChapterCount(Number(e.target.value) || 1)}
              />
            </label>
            <label>
              <span className="text-zinc-400">段落数 paragraphCount</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
                value={paragraphCount}
                min={1}
                onChange={(e) =>
                  setParagraphCount(Number(e.target.value) || 1)
                }
              />
            </label>
            <label>
              <span className="text-zinc-400">batchSize</span>
              <input
                type="number"
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
                value={batchSize}
                min={1}
                onChange={(e) => setBatchSize(Number(e.target.value) || 1)}
              />
            </label>
            <label>
              <span className="text-zinc-400">genrePreference</span>
              <input
                className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
                value={genrePreference}
                onChange={(e) => setGenrePreference(e.target.value)}
              />
            </label>
          </div>
          <label className="block text-sm">
            <span className="text-zinc-400">stylePreference</span>
            <input
              className="mt-1 w-full bg-zinc-950 border border-zinc-700 rounded p-2"
              value={stylePreference}
              onChange={(e) => setStylePreference(e.target.value)}
            />
          </label>
          <button
            className="bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 rounded text-sm"
            disabled={starting}
            onClick={startRun}
          >
            {starting ? "创建中..." : "开始生成"}
          </button>
        </section>

        {runState && (
          <section className="space-y-3 bg-zinc-900 border border-zinc-800 rounded p-4">
            <div className="text-sm text-zinc-400">
              runId: <span className="text-zinc-200">{runState.runId}</span>{" "}
              · status:{" "}
              <span className="text-zinc-200">{runState.status}</span> · stage:{" "}
              <span className="text-zinc-200">{runState.stage}</span>
            </div>
            <div className="text-xs text-zinc-400">{progressLine}</div>
            {runState.finalError && (
              <div className="text-rose-400 text-sm">
                run failed: {runState.finalError}
              </div>
            )}
          </section>
        )}

        {runState?.novels.map((novel) => (
          <NovelBlock
            key={novel.novelIndex}
            novel={novel}
            retry={retry}
            retrying={retrying}
          />
        ))}
      </div>
    </div>
  );
}

function NovelBlock({
  novel,
  retry,
  retrying,
}: {
  novel: NovelView;
  retry: (n: number, c: number, p: number) => void;
  retrying: string | null;
}) {
  const title =
    (novel.world as { novelTitle?: string } | undefined)?.novelTitle ??
    `小说 ${novel.novelIndex + 1}`;
  const tone =
    (novel.world as { tone?: string } | undefined)?.tone ?? "";
  return (
    <section className="bg-zinc-900 border border-zinc-800 rounded p-4 space-y-3">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold">
          [{novel.novelIndex}] {title}
        </h2>
        <span className="text-xs text-zinc-500">{tone}</span>
      </header>
      {novel.error && (
        <div className="text-rose-400 text-sm">world 失败: {novel.error}</div>
      )}
      {novel.streamingBuffer && !novel.world && (
        <pre className="text-xs whitespace-pre-wrap text-zinc-400 max-h-40 overflow-auto">
          {novel.streamingBuffer.slice(-1500)}
        </pre>
      )}
      {novel.world && (
        <details className="text-xs text-zinc-300">
          <summary className="cursor-pointer text-zinc-400">世界观</summary>
          <pre className="whitespace-pre-wrap mt-2">
            {JSON.stringify(novel.world, null, 2)}
          </pre>
        </details>
      )}

      <div className="space-y-3">
        {novel.chapters.map((chapter) => (
          <div
            key={chapter.chapterIndex}
            className="border border-zinc-800 rounded p-3 space-y-2"
          >
            <div className="text-sm">
              <span className="text-zinc-400">第{chapter.chapterIndex}章</span>{" "}
              <span className="font-medium">{chapter.chapterTitle}</span>
            </div>
            {chapter.error && (
              <div className="text-rose-400 text-xs">
                chapterPlan 失败: {chapter.error}
              </div>
            )}
            {chapter.streamingBuffer && !chapter.paragraphPlan && (
              <pre className="text-xs whitespace-pre-wrap text-zinc-500 max-h-32 overflow-auto">
                {chapter.streamingBuffer.slice(-1200)}
              </pre>
            )}
            <div className="space-y-2">
              {chapter.paragraphs.map((paragraph) => {
                const key = `${novel.novelIndex}/${chapter.chapterIndex}/${paragraph.paragraphIndex}`;
                return (
                  <div
                    key={paragraph.paragraphIndex}
                    className="bg-zinc-950 border border-zinc-800 rounded p-2"
                  >
                    <div className="flex items-center justify-between text-xs text-zinc-400">
                      <span>段落 {paragraph.paragraphIndex}</span>
                      <button
                        className="text-emerald-400 hover:text-emerald-300 disabled:opacity-50"
                        disabled={retrying === key}
                        onClick={() =>
                          retry(
                            novel.novelIndex,
                            chapter.chapterIndex,
                            paragraph.paragraphIndex,
                          )
                        }
                      >
                        {retrying === key ? "重试中..." : "重试"}
                      </button>
                    </div>
                    {paragraph.error && (
                      <div className="text-rose-400 text-xs mt-1">
                        {paragraph.error}
                      </div>
                    )}
                    {paragraph.content ? (
                      <p className="text-sm text-zinc-100 mt-1 whitespace-pre-wrap">
                        {paragraph.content}
                      </p>
                    ) : paragraph.streamingBuffer ? (
                      <pre className="text-xs text-zinc-500 mt-1 whitespace-pre-wrap max-h-32 overflow-auto">
                        {paragraph.streamingBuffer.slice(-800)}
                      </pre>
                    ) : (
                      <div className="text-xs text-zinc-600 mt-1">待生成</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {novel.fullNovelContent && (
        <details className="text-sm text-zinc-200">
          <summary className="cursor-pointer text-zinc-400">
            完整小说正文
          </summary>
          <pre className="whitespace-pre-wrap mt-2">
            {novel.fullNovelContent}
          </pre>
        </details>
      )}
    </section>
  );
}
