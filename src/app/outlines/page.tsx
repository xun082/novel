"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import rwkvService from "@/services";
import { OutlineCard } from "@/components/OutlineCard";
import {
  clearLaunchSessionStorage,
  clearPersistedOutlines,
  peekLaunchSession,
  persistOutlines,
  readPersistedOutlines,
} from "@/lib/novel-data";
import { cn } from "@/lib/utils";
import { extractParseableJsonObject, stripLlmJsonNoise } from "@/lib/extract-parseable-json";
import { RwkvProductionUpstreamSettings } from "@/components/RwkvProductionUpstreamSettings";

interface Chapter {
  id: number;
  title: string;
  outline: string;
  content: string;
}

interface Outline {
  id: number;
  title: string;
  summary: string;
  chapters: Chapter[];
  rawContent: string;
}

const OUTLINE_TOTAL = 10;
// 上游 /big_batch/completions 对「单请求 N (contents.length)」有硬上限（实测 N≥135 必空 body，
// N=120 稳定可用）。10 × 8 = 80 有充裕余量，同时也给每条 prompt 更多 max_tokens 空间，
// 章节正文不容易因 token 用尽而被截断。
const DEFAULT_CHAPTER_COUNT = 8;

interface PromptPreset {
  label: string;
  tagline: string;
  prompt: string;
  accent: string;
}

const PROMPT_PRESETS: PromptPreset[] = [
  {
    label: "玄幻修仙",
    tagline: "升级流 · 宗门秘境",
    prompt: "玄幻修仙，升级流，主角资质平平却另辟蹊径，含宗门、秘境、古神血脉。",
    accent: "from-sky-500/90 to-cyan-500/90",
  },
  {
    label: "都市职场",
    tagline: "商战 · 逆袭",
    prompt: "都市现代，职场商战，主角从底层实习生起步，步步为营直面家族企业博弈。",
    accent: "from-emerald-500/90 to-teal-500/90",
  },
  {
    label: "末世生存",
    tagline: "丧尸 · 硬核",
    prompt: "末世丧尸题材，资源稀缺、人性博弈，主角带领小队穿越废土寻找避难所。",
    accent: "from-rose-500/90 to-orange-500/90",
  },
  {
    label: "硬核科幻",
    tagline: "星海 · 指挥官",
    prompt: "硬科幻，星际舰队指挥官视角，跨星系战争，含外星文明与高维武器设定。",
    accent: "from-indigo-500/90 to-purple-500/90",
  },
  {
    label: "悬疑推理",
    tagline: "连环案 · 烧脑反转",
    prompt: "现代悬疑推理，连环凶杀案，主角是天才犯罪心理学家，双线叙事层层反转。",
    accent: "from-slate-600/90 to-zinc-600/90",
  },
  {
    label: "古代权谋",
    tagline: "朝堂 · 党争",
    prompt: "古代宫廷权谋，寒门状元入局朝堂，党争、夺嫡、边疆战事交织推进。",
    accent: "from-amber-500/90 to-yellow-600/90",
  },
  {
    label: "仙侠武侠",
    tagline: "江湖 · 血海深仇",
    prompt: "传统仙侠武侠，江湖恩怨，主角背负灭门之仇，拜师习武逐步揭开身世谜团。",
    accent: "from-fuchsia-500/90 to-pink-500/90",
  },
  {
    label: "异世冒险",
    tagline: "穿越 · 魔法职业",
    prompt: "异世界穿越，奇幻大陆含职业与魔法系统，主角组队探索迷宫秘境并揭露神祇阴谋。",
    accent: "from-lime-500/90 to-green-600/90",
  },
];

const isStableContent = (value: string): boolean => {
  const text = value.trim();
  if (!text) return false;
  if (text.includes("生成中...") || text.includes("扩写中...") || text.includes("生成失败")) {
    return false;
  }
  // 仅把「续写」流式前缀视为进行中，避免正文里出现「续写」字样被误判
  if (text.startsWith("续写中")) return false;
  return true;
};

const createOutlinePlaceholders = (count: number): Outline[] =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `大纲 ${index + 1}`,
    summary: "",
    chapters: [],
    rawContent: "",
  }));

const stripSeedQueryFromUrl = (): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("seed")) return;
  url.searchParams.delete("seed");
  const q = url.searchParams.toString();
  window.history.replaceState(null, "", `${url.pathname}${q ? `?${q}` : ""}${url.hash}`);
};

export default function Home() {
  const [novelInput, setNovelInput] = useState("玄幻，升级流，主角成长线清晰，含宗门与秘境线。");
  const [isGenerating, setIsGenerating] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const outlineGenerationLockRef = useRef(false);
  const chapterGenerationLockRef = useRef(false);

  const [outlines, setOutlines] = useState<Outline[]>(() =>
    createOutlinePlaceholders(OUTLINE_TOTAL),
  );

  useEffect(() => {
    // Backward compatibility: strip legacy query params from older shared links.
    const url = new URL(window.location.href);
    const hadLegacyQuery = url.searchParams.has("step") || url.searchParams.has("view");
    if (!hadLegacyQuery) return;

    url.searchParams.delete("step");
    url.searchParams.delete("view");

    const nextQuery = url.searchParams.toString();
    const nextURL = `${url.pathname}${nextQuery ? `?${nextQuery}` : ""}${url.hash}`;
    window.history.replaceState({}, "", nextURL);
  }, []);

  useEffect(() => {
    if (!storageReady) return;
    // 流式阶段高频更新 outlines 时，同步 stringify+localStorage 会卡主线程导致「像是一次性画完」
    if (isGenerating) {
      const t = window.setTimeout(() => {
        persistOutlines(outlines);
      }, 450);
      return () => window.clearTimeout(t);
    }
    persistOutlines(outlines);
  }, [outlines, storageReady, isGenerating]);

  const extractJSON = extractParseableJsonObject;

  const extractStreamingChapterText = (raw: string): string => {
    const parsed = extractJSON(raw);
    if (typeof parsed?.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }

    const cleaned = stripLlmJsonNoise(raw);

    const key = cleaned.match(/"content"\s*:\s*"/);
    if (!key || key.index === undefined) {
      return "";
    }

    const start = key.index + key[0].length;
    const tail = cleaned.slice(start);

    let end = tail.length;
    let escaped = false;
    for (let i = 0; i < tail.length; i++) {
      const char = tail[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        end = i;
        break;
      }
    }

    return tail
      .slice(0, end)
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
      .trim();
  };

  const buildChapters = (
    jsonData: Record<string, unknown> | null,
    count: number,
    withFallback: boolean,
  ): Chapter[] => {
    const raw = (jsonData?.chapters || jsonData?.章节 || []) as unknown;
    const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];

    const parsed = list.slice(0, count).map((chapterData, index) => ({
      id: index + 1,
      title:
        (chapterData.title as string) ||
        (chapterData.标题 as string) ||
        (chapterData.chapter as string) ||
        `第${index + 1}章`,
      outline:
        (chapterData.outline as string) ||
        (chapterData.梗概 as string) ||
        (chapterData.内容梗概 as string) ||
        "待生成",
      content: "",
    }));

    if (parsed.length > 0 || !withFallback) return parsed;

    return Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      title: `第${i + 1}章`,
      outline: "待生成",
      content: "",
    }));
  };

  const parseOutline = (rawContent: string, index: number): Outline => {
    const jsonData = extractJSON(rawContent);
    const title =
      (jsonData?.title as string) ||
      (jsonData?.标题 as string) ||
      (jsonData?.小说标题 as string) ||
      `大纲 ${index + 1}`;
    const summary =
      (jsonData?.summary as string) ||
      (jsonData?.核心梗概 as string) ||
      (jsonData?.梗概 as string) ||
      "";

    return {
      id: index + 1,
      title,
      summary,
      chapters: buildChapters(jsonData, DEFAULT_CHAPTER_COUNT, false),
      rawContent,
    };
  };

  const generateOutlinesAndChapters = async (overridePrompt?: string) => {
    if (outlineGenerationLockRef.current || chapterGenerationLockRef.current) return;

    const promptText = (overridePrompt ?? novelInput).trim();
    if (!promptText) return;
    stripSeedQueryFromUrl();
    outlineGenerationLockRef.current = true;
    setIsGenerating(true);

    const placeholders = createOutlinePlaceholders(OUTLINE_TOTAL);
    setOutlines(placeholders);

    const pendingRaw = new Map<number, string>();
    let streamRaf: number | null = null;

    const flushPendingRawToState = () => {
      if (pendingRaw.size === 0) return;
      const batch = new Map(pendingRaw);
      pendingRaw.clear();
      setOutlines((prev) => {
        const next = prev.slice();
        let changed = false;
        for (const [idx, raw] of batch) {
          if (!prev[idx]) continue;
          next[idx] = { ...next[idx], rawContent: raw };
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    const scheduleRawUpdate = (index: number, content: string) => {
      pendingRaw.set(index, content);
      if (streamRaf != null) return;
      streamRaf = requestAnimationFrame(() => {
        streamRaf = null;
        if (!outlineGenerationLockRef.current) return;
        flushPendingRawToState();
      });
    };

    try {
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        promptText,
        DEFAULT_CHAPTER_COUNT,
        OUTLINE_TOTAL,
        (index, content) => {
          if (!outlineGenerationLockRef.current) return;
          scheduleRawUpdate(index, content);
        },
        (index, content) => {
          if (!outlineGenerationLockRef.current) return;
          if (streamRaf != null) {
            cancelAnimationFrame(streamRaf);
            streamRaf = null;
          }
          flushPendingRawToState();
          setOutlines((prev) => {
            if (!prev[index]) return prev;
            const parsed = parseOutline(content, index);
            const next = prev.slice();
            next[index] = {
              ...parsed,
              chapters:
                parsed.chapters.length > 0
                  ? parsed.chapters
                  : buildChapters(extractJSON(parsed.rawContent), DEFAULT_CHAPTER_COUNT, true),
            };
            return next;
          });
        },
      );

      if (streamRaf != null) {
        cancelAnimationFrame(streamRaf);
        streamRaf = null;
      }
      flushPendingRawToState();

      const finalizedOutlines = rawOutlines.map((raw, index) => {
        const parsed = parseOutline(raw, index);
        return {
          ...parsed,
          chapters:
            parsed.chapters.length > 0
              ? parsed.chapters
              : buildChapters(extractJSON(parsed.rawContent), DEFAULT_CHAPTER_COUNT, true),
        };
      });
      setOutlines(finalizedOutlines);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`大纲生成失败：${message}`);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    } finally {
      outlineGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    const seed = params.get("seed");
    if (seed) {
      let prompt = "";
      try {
        prompt = decodeURIComponent(seed);
      } catch {
        stripSeedQueryFromUrl();
      }
      if (prompt.trim()) {
        setNovelInput(prompt);
        setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
        clearPersistedOutlines();
        clearLaunchSessionStorage();
        setStorageReady(true);
        return;
      }
    }

    const session = peekLaunchSession();
    if (session?.prompt.trim()) {
      setNovelInput(session.prompt);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
      clearPersistedOutlines();
      clearLaunchSessionStorage();
      setStorageReady(true);
      if (session.autoGenerate) {
        void generateOutlinesAndChapters(session.prompt);
      }
      return;
    }

    const cached = readPersistedOutlines() as Outline[];
    if (cached.length > 0) {
      setOutlines(cached);
    }
    setStorageReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openOutlineDetails = (outline: Outline) => {
    if (!outline.rawContent.trim()) {
      window.alert(`《${outline.title}》仍在生成中，请稍后重试。`);
      return;
    }

    persistOutlines(outlines);
    const nextPath = `/outline/${outline.id}`;
    const popup = window.open(nextPath, "_blank", "noopener,noreferrer");
    if (!popup) {
      window.alert("浏览器拦截了新标签页，请允许弹窗后重试（当前生成页已保留）。");
      return;
    }
  };

  const applyChapterUpdates = (
    updates: Array<{ outlineId: number; chapterIndex: number; content: string }>,
  ) => {
    if (updates.length === 0) return;
    setOutlines((prev) => {
      const next = prev.slice();
      let changed = false;
      const outlineIndexMap = new Map<number, number>();

      for (const { outlineId, chapterIndex, content } of updates) {
        let outlineIdx = outlineIndexMap.get(outlineId);
        if (outlineIdx === undefined) {
          outlineIdx = next.findIndex((outline) => outline.id === outlineId);
          outlineIndexMap.set(outlineId, outlineIdx);
        }

        if (outlineIdx === -1) continue;
        const target = next[outlineIdx];
        if (!target?.chapters[chapterIndex]) continue;
        if (target.chapters[chapterIndex].content === content) continue;

        const chapters = target.chapters.slice();
        chapters[chapterIndex] = { ...chapters[chapterIndex], content };
        next[outlineIdx] = { ...target, chapters };
        changed = true;
      }

      return changed ? next : prev;
    });
  };

  const generateAllChapterContents = async (regenerateAll = false) => {
    if (chapterGenerationLockRef.current || outlineGenerationLockRef.current) return;

    const snapshot = outlines;
    const tasks = snapshot.flatMap((outline) =>
      outline.chapters
        .map((chapter, chapterIndex) => ({ outline, chapter, chapterIndex }))
        .filter(({ chapter }) => {
          const outlineText = chapter.outline?.trim();
          if (!outlineText || outlineText === "待生成") return false;
          if (regenerateAll) return true;
          return !isStableContent(chapter.content);
        }),
    );

    if (tasks.length === 0) {
      if (!regenerateAll) {
        window.alert(
          "没有需要续写的章节：各章正文已就绪，或章节梗概仍为空/为「待生成」。若刚中断过生成，请点「重置」后重新生成大纲。",
        );
      }
      return;
    }

    const pendingLabel = "续写中";
    const pendingChapterUpdates = new Map<
      string,
      { outlineId: number; chapterIndex: number; content: string }
    >();
    let chapterStreamRaf: number | null = null;

    const flushPendingChapterUpdates = () => {
      if (pendingChapterUpdates.size === 0) return;
      const batch = Array.from(pendingChapterUpdates.values());
      pendingChapterUpdates.clear();
      applyChapterUpdates(batch);
    };

    const scheduleChapterUpdate = (update: {
      outlineId: number;
      chapterIndex: number;
      content: string;
    }) => {
      pendingChapterUpdates.set(
        `${update.outlineId}:${update.chapterIndex}`,
        update,
      );

      if (chapterStreamRaf != null) return;
      chapterStreamRaf = requestAnimationFrame(() => {
        chapterStreamRaf = null;
        if (!chapterGenerationLockRef.current) return;
        flushPendingChapterUpdates();
      });
    };

    const flushChapterUpdateImmediately = (update: {
      outlineId: number;
      chapterIndex: number;
      content: string;
    }) => {
      pendingChapterUpdates.set(
        `${update.outlineId}:${update.chapterIndex}`,
        update,
      );
      if (chapterStreamRaf != null) {
        cancelAnimationFrame(chapterStreamRaf);
        chapterStreamRaf = null;
      }
      flushPendingChapterUpdates();
    };

    setIsGenerating(true);
    chapterGenerationLockRef.current = true;

    try {
      const rawContents = await rwkvService.generateChaptersByTasks(
        tasks.map(({ chapter }) => ({
          title: chapter.title,
          outline: chapter.outline,
        })),
        (taskIndex, content) => {
          const task = tasks[taskIndex];
          if (!task) return;
          const streamText = extractStreamingChapterText(content);
          const pending = streamText
            ? `${pendingLabel}...\n${streamText}`
            : `${pendingLabel}... ${content.length}字`;
          scheduleChapterUpdate({
            outlineId: task.outline.id,
            chapterIndex: task.chapterIndex,
            content: pending,
          });
        },
        (taskIndex, content) => {
          const task = tasks[taskIndex];
          if (!task) return;
          const jsonData = extractJSON(content);
          const finalContent = ((jsonData?.content as string) || content || "").trim();
          if (finalContent) {
            flushChapterUpdateImmediately({
              outlineId: task.outline.id,
              chapterIndex: task.chapterIndex,
              content: finalContent,
            });
          }
        },
      );

      if (chapterStreamRaf != null) {
        cancelAnimationFrame(chapterStreamRaf);
        chapterStreamRaf = null;
      }
      flushPendingChapterUpdates();

      const finalBatch: Array<{ outlineId: number; chapterIndex: number; content: string }> = [];
      tasks.forEach((task, taskIndex) => {
        const raw = rawContents[taskIndex] || "";
        const jsonData = extractJSON(raw);
        const finalContent = ((jsonData?.content as string) || raw || "").trim();
        if (finalContent) {
          finalBatch.push({
            outlineId: task.outline.id,
            chapterIndex: task.chapterIndex,
            content: finalContent,
          });
        }
      });
      applyChapterUpdates(finalBatch);
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      window.alert(`续写失败：${message}`);
    } finally {
      if (chapterStreamRaf != null) {
        cancelAnimationFrame(chapterStreamRaf);
        chapterStreamRaf = null;
      }
      pendingChapterUpdates.clear();
      chapterGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  const resetFlow = () => {
    outlineGenerationLockRef.current = false;
    chapterGenerationLockRef.current = false;
    setIsGenerating(false);
    stripSeedQueryFromUrl();
    clearPersistedOutlines();
    setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
  };

  const outlinesReady = useMemo(
    () => outlines.some((outline) => outline.chapters.length > 0),
    [outlines],
  );

  const allChapterBodiesComplete = useMemo(() => {
    if (!outlines.some((o) => o.chapters.length > 0)) return false;

    const chaptersNeedingWork = outlines.flatMap((outline) =>
      outline.chapters.filter((chapter) => {
        const outlineText = chapter.outline?.trim();
        return Boolean(outlineText) && outlineText !== "待生成" && !isStableContent(chapter.content);
      }),
    );

    const hasAnyStableChapter = outlines.some((o) =>
      o.chapters.some((c) => isStableContent(c.content)),
    );

    return chaptersNeedingWork.length === 0 && hasAnyStableChapter;
  }, [outlines]);

  const isSecondRound = outlinesReady;
  const primaryButtonLabel = isGenerating
    ? "处理中"
    : !isSecondRound
      ? "生成大纲"
      : allChapterBodiesComplete
        ? "重新生成"
        : "续写全部";
  const disablePrimaryButton =
    isGenerating || (!isSecondRound && !novelInput.trim());

  const handlePrimaryAction = () => {
    if (isGenerating) return;
    if (isSecondRound) {
      void generateAllChapterContents(allChapterBodiesComplete);
      return;
    }
    void generateOutlinesAndChapters();
  };

  const handlePresetSelect = (prompt: string) => {
    if (isGenerating) return;
    setNovelInput(prompt);
  };

  return (
    <div className="min-h-screen w-full min-w-0 overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)]">
      <RwkvProductionUpstreamSettings />
      <main className="w-full pb-36">
        {!outlinesReady && !isGenerating ? (
          <section className="flex min-h-[calc(100vh-76px)] w-full items-center justify-center px-4">
            <div className="w-full max-w-5xl">
              <div className="mb-6 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  选一种风格，开始写你的小说
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  点预设会把文案填到底栏；确认后点「生成大纲」并发生成 {OUTLINE_TOTAL} 份 {DEFAULT_CHAPTER_COUNT}{" "}
                  章大纲；也可直接改底栏再生成。
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {PROMPT_PRESETS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handlePresetSelect(preset.prompt)}
                    className="group relative overflow-hidden rounded-xl border border-border/70 bg-card/80 p-4 text-left shadow-sm backdrop-blur-sm transition-all hover:-translate-y-0.5 hover:shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <div
                      className={`absolute inset-x-0 top-0 h-1 bg-linear-to-r ${preset.accent}`}
                      aria-hidden
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-base font-semibold text-foreground">{preset.label}</span>
                      <Sparkles className="h-3.5 w-3.5 text-muted-foreground transition-colors group-hover:text-primary" />
                    </div>
                    <p className="mt-0.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/80">
                      {preset.tagline}
                    </p>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-muted-foreground">
                      {preset.prompt}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          </section>
        ) : (
          <section className="relative z-0 grid min-h-0 h-[calc(100vh-7.5rem)] grid-cols-5 grid-rows-2 items-stretch gap-3 p-3">
            {outlines.map((outline) => (
              <OutlineCard
                key={outline.id}
                outline={outline}
                onSelect={openOutlineDetails}
                isGenerating={isGenerating}
              />
            ))}
          </section>
        )}

      </main>

      <div className="pointer-events-none fixed bottom-[max(0.75rem,env(safe-area-inset-bottom,0px))] left-1/2 z-50 w-[min(720px,calc(100%-24px))] max-w-full -translate-x-1/2">
        <div className="pointer-events-auto max-w-full overflow-x-hidden rounded-xl border border-border/80 bg-card/95 px-3 py-2.5 shadow-[0_14px_45px_-24px_rgba(2,6,23,0.95)] ring-1 ring-border/30 backdrop-blur-xl">
          <div className="flex min-w-0 max-w-full items-end gap-2 overflow-x-hidden">
            <Textarea
              value={novelInput}
              onChange={(e) => setNovelInput(e.target.value)}
              readOnly={isSecondRound}
              placeholder={
                isSecondRound
                  ? "创建时的总设定（只读）；续写每章仅依据该章标题与梗概"
                  : "题材、世界观、主角设定..."
              }
              rows={2}
              className={cn(
                "min-h-18 max-h-36 min-w-0 flex-1 basis-0 resize-none overflow-y-auto overflow-x-hidden rounded-lg border border-border/70 bg-background/90 px-3 py-2.5 text-sm leading-relaxed text-foreground shadow-none focus-visible:ring-1 focus-visible:ring-ring/40",
                isSecondRound &&
                  "cursor-not-allowed bg-muted/40 text-foreground/90 ring-1 ring-border/60 focus-visible:ring-0",
              )}
            />
            <Button
              variant="ghost"
              disabled={isGenerating}
              onClick={resetFlow}
              className="h-9 shrink-0 rounded-md px-3 text-sm"
            >
              重置
            </Button>
            <Button
              onClick={handlePrimaryAction}
              disabled={disablePrimaryButton}
              className="h-9 shrink-0 rounded-full px-4 text-sm"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  处理中
                </>
              ) : isSecondRound ? (
                <>
                  {allChapterBodiesComplete && !isGenerating ? (
                    <RefreshCw className="mr-1.5 h-4 w-4" />
                  ) : (
                    <Wand2 className="mr-1.5 h-4 w-4" />
                  )}
                  {primaryButtonLabel}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  {primaryButtonLabel}
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
