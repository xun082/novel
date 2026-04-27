"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles, Wand2 } from "lucide-react";
import rwkvService from "@/services";
import { OutlineCard } from "@/components/OutlineCard";
import { consumeLaunchPrompt, persistOutlines, readPersistedOutlines } from "@/lib/novel-data";

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
  return !text.includes("生成中...") && !text.includes("扩写中...") && !text.includes("生成失败");
};

const createOutlinePlaceholders = (count: number): Outline[] =>
  Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    title: `大纲 ${index + 1}`,
    summary: "",
    chapters: [],
    rawContent: "",
  }));

export default function Home() {
  const [novelInput, setNovelInput] = useState("玄幻，升级流，主角成长线清晰，含宗门与秘境线。");
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState("");
  const [launchPrompt] = useState<string>(() => consumeLaunchPrompt());
  const outlineGenerationLockRef = useRef(false);
  const chapterGenerationLockRef = useRef(false);

  const [outlines, setOutlines] = useState<Outline[]>(() => {
    if (launchPrompt.trim()) {
      return createOutlinePlaceholders(OUTLINE_TOTAL);
    }
    const cached = readPersistedOutlines() as Outline[];
    if (cached.length > 0) return cached;
    return createOutlinePlaceholders(OUTLINE_TOTAL);
  });

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
    persistOutlines(outlines);
  }, [outlines]);

  const extractJSON = (text: string): Record<string, unknown> | null => {
    if (!text || text.trim().length === 0) return null;

    try {
      let cleaned = text.trim();
      cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/g, "");
      cleaned = cleaned.replace(/^```(?:json)?\s*/gi, "");
      cleaned = cleaned.replace(/\s*```\s*$/g, "");

      const firstBrace = cleaned.indexOf("{");
      const lastBrace = cleaned.lastIndexOf("}");
      if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) return null;

      cleaned = cleaned.substring(firstBrace, lastBrace + 1);
      return JSON.parse(cleaned) as Record<string, unknown>;
    } catch {
      try {
        const fixed = text
          .trim()
          .replace(/<think>[\s\S]*?<\/think>/g, "")
          .replace(/^```(?:json)?\s*/gi, "")
          .replace(/\s*```\s*$/g, "");
        const matches = fixed.match(/\{[\s\S]*\}/);
        if (!matches) return null;
        return JSON.parse(matches[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  };

  const extractStreamingChapterText = (raw: string): string => {
    const parsed = extractJSON(raw);
    if (typeof parsed?.content === "string" && parsed.content.trim()) {
      return parsed.content.trim();
    }

    const cleaned = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^```(?:json)?\s*/gi, "")
      .replace(/\s*```$/g, "")
      .trim();

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
    outlineGenerationLockRef.current = true;
    setIsGenerating(true);
    setCurrentStep(`第一轮：正在并发生成 ${OUTLINE_TOTAL} 份小说大纲（含章节梗概）...`);

    const placeholders = createOutlinePlaceholders(OUTLINE_TOTAL);
    setOutlines(placeholders);

    try {
      const rawOutlines = await rwkvService.generateMultipleOutlines(
        promptText,
        DEFAULT_CHAPTER_COUNT,
        OUTLINE_TOTAL,
        (index, content) => {
          if (!outlineGenerationLockRef.current) return;
          setOutlines((prev) => {
            if (!prev[index]) return prev;
            const next = prev.slice();
            next[index] = {
              ...next[index],
              rawContent: content,
            };
            return next;
          });
        },
      );

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

      const totalChaptersPlanned = finalizedOutlines.reduce(
        (sum, outline) => sum + outline.chapters.length,
        0,
      );
      setCurrentStep(
        `第一轮完成：${finalizedOutlines.length} 份大纲、共 ${totalChaptersPlanned} 章梗概。先点击「续写全部」生成正文，全部完成后可新标签页查看详情。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setCurrentStep(`大纲生成失败：${message}`);
      setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
    } finally {
      outlineGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (!launchPrompt.trim()) return;
    setNovelInput(launchPrompt);
    void generateOutlinesAndChapters(launchPrompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launchPrompt]);

  const openOutlineDetails = (outline: Outline) => {
    if (!outline.rawContent.trim()) {
      setCurrentStep(
        `《${outline.title}》仍在生成中，请稍后重试。`,
      );
      return;
    }

    persistOutlines(outlines);
    const nextPath = `/outline/${outline.id}`;
    const popup = window.open(nextPath, "_blank", "noopener,noreferrer");
    if (!popup) {
      setCurrentStep("浏览器拦截了新标签页，请允许弹窗后重试（当前生成页已保留）。");
      return;
    }
    setCurrentStep(`已在新标签页打开《${outline.title}》详情页。`);
  };

  const applyChapterUpdate = (
    outlineId: number,
    chapterIndex: number,
    newContent: string,
  ) => {
    setOutlines((prev) => {
      const outlineIdx = prev.findIndex((outline) => outline.id === outlineId);
      if (outlineIdx === -1) return prev;
      const target = prev[outlineIdx];
      if (!target.chapters[chapterIndex]) return prev;
      const chapters = target.chapters.slice();
      chapters[chapterIndex] = { ...chapters[chapterIndex], content: newContent };
      const next = prev.slice();
      next[outlineIdx] = { ...target, chapters };
      return next;
    });
  };

  const generateAllChapterContents = async () => {
    if (chapterGenerationLockRef.current || outlineGenerationLockRef.current) return;

    const snapshot = outlines;
    const tasks = snapshot.flatMap((outline) =>
      outline.chapters
        .map((chapter, chapterIndex) => ({ outline, chapter, chapterIndex }))
        .filter(({ chapter }) => {
          const outlineText = chapter.outline?.trim();
          return Boolean(outlineText) && outlineText !== "待生成" && !isStableContent(chapter.content);
        }),
    );

    if (tasks.length === 0) {
      setCurrentStep("第二轮已完成，无需继续续写。");
      return;
    }

    const pendingLabel = "续写中";

    setIsGenerating(true);
    chapterGenerationLockRef.current = true;
    setCurrentStep(
      `第二轮：并发续写 ${tasks.length} 章（${snapshot.length} 份大纲 × 约 ${DEFAULT_CHAPTER_COUNT} 章，流式输出）...`,
    );

    const startedTasks = new Set<number>();

    try {
      const rawContents = await rwkvService.generateChaptersByTasks(
        tasks.map(({ outline, chapter }) => ({
          novelContext: {
            title: outline.title,
            summary: outline.summary,
          },
          chapter: {
            title: chapter.title,
            outline: chapter.outline,
          },
        })),
        (taskIndex, content) => {
          const task = tasks[taskIndex];
          if (!task) return;
          if (!startedTasks.has(taskIndex)) {
            startedTasks.add(taskIndex);
            setCurrentStep(
              `第二轮续写中：已启动 ${startedTasks.size}/${tasks.length} 章`,
            );
          }
          const streamText = extractStreamingChapterText(content);
          const pending = streamText
            ? `${pendingLabel}...\n${streamText}`
            : `${pendingLabel}... ${content.length}字`;
          applyChapterUpdate(task.outline.id, task.chapterIndex, pending);
        },
      );

      let successCount = 0;
      tasks.forEach((task, taskIndex) => {
        const raw = rawContents[taskIndex] || "";
        const jsonData = extractJSON(raw);
        const finalContent = ((jsonData?.content as string) || raw || "").trim();
        if (finalContent) {
          applyChapterUpdate(task.outline.id, task.chapterIndex, finalContent);
          successCount += 1;
        }
      });

      setCurrentStep(
        `第二轮续写完成：成功 ${successCount}/${tasks.length} 章。`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "未知错误";
      setCurrentStep(`续写失败：${message}`);
    } finally {
      chapterGenerationLockRef.current = false;
      setIsGenerating(false);
    }
  };

  const resetFlow = () => {
    outlineGenerationLockRef.current = false;
    chapterGenerationLockRef.current = false;
    setIsGenerating(false);
    setCurrentStep("");
    setOutlines(createOutlinePlaceholders(OUTLINE_TOTAL));
  };

  const globalTotalChapters = useMemo(
    () => outlines.reduce((sum, outline) => sum + outline.chapters.length, 0),
    [outlines],
  );
  const globalCompletedChapters = useMemo(
    () =>
      outlines.reduce(
        (sum, outline) =>
          sum + outline.chapters.filter((chapter) => isStableContent(chapter.content)).length,
        0,
      ),
    [outlines],
  );

  const outlinesReady = useMemo(
    () => outlines.some((outline) => outline.chapters.length > 0),
    [outlines],
  );
  const progressText = `完成章节 ${globalCompletedChapters}/${globalTotalChapters || OUTLINE_TOTAL * DEFAULT_CHAPTER_COUNT}`;

  const isSecondRound = outlinesReady;
  const primaryButtonLabel = isGenerating
    ? "处理中"
    : !isSecondRound
      ? "生成大纲"
      : "续写全部";
  const disablePrimaryButton =
    isGenerating || (!isSecondRound && !novelInput.trim());

  const handlePrimaryAction = () => {
    if (isGenerating) return;
    if (isSecondRound) {
      void generateAllChapterContents();
      return;
    }
    void generateOutlinesAndChapters();
  };

  const handlePresetSelect = (prompt: string) => {
    if (isGenerating) return;
    setNovelInput(prompt);
    void generateOutlinesAndChapters(prompt);
  };

  return (
    <div className="min-h-screen w-screen overflow-x-hidden bg-[radial-gradient(circle_at_10%_20%,rgba(56,189,248,0.14),transparent_45%),radial-gradient(circle_at_90%_10%,rgba(236,72,153,0.12),transparent_45%),linear-gradient(180deg,#020617,#030712_48%,#0b1120)]">
      <main className="w-full pb-16">
        {!outlinesReady && !isGenerating ? (
          <section className="flex min-h-[calc(100vh-76px)] w-full items-center justify-center px-4">
            <div className="w-full max-w-5xl">
              <div className="mb-6 text-center">
                <h1 className="text-3xl font-semibold tracking-tight text-foreground">
                  选一种风格，开始写你的小说
                </h1>
                <p className="mt-2 text-sm text-muted-foreground">
                  点击任意预设即可一键并发生成 {OUTLINE_TOTAL} 份 {DEFAULT_CHAPTER_COUNT} 章的大纲；也可以在下方输入自定义需求。
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
          <section className="grid h-[calc(100vh-76px)] grid-cols-5 grid-rows-2 items-stretch gap-3 p-3">
            {outlines.map((outline) => (
              <OutlineCard
                key={outline.id}
                outline={outline}
                onSelect={openOutlineDetails}
              />
            ))}
          </section>
        )}

      </main>

      <div className="pointer-events-none fixed bottom-2 left-1/2 z-30 w-[min(720px,calc(100vw-24px))] -translate-x-1/2">
        <div className="pointer-events-auto rounded-xl border border-border/70 bg-card/85 px-2 py-1.5 shadow-[0_14px_45px_-24px_rgba(2,6,23,0.95)] backdrop-blur-xl">
          <div className="flex items-center gap-1.5">
            <Textarea
              value={novelInput}
              onChange={(e) => setNovelInput(e.target.value)}
              placeholder="题材、世界观、主角设定..."
              rows={1}
              className="min-h-[32px] max-h-[72px] flex-1 resize-none overflow-y-auto rounded-md border border-border/60 bg-background/80 px-2 py-1 text-xs leading-5 shadow-none focus-visible:ring-0"
            />
            <Button variant="ghost" disabled={isGenerating} onClick={resetFlow} className="h-7 rounded-md px-2 text-xs">
              重置
            </Button>
            <Button
              onClick={handlePrimaryAction}
              disabled={disablePrimaryButton}
              className="h-7 rounded-full px-3 text-xs"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                  处理中
                </>
              ) : isSecondRound ? (
                <>
                  <Wand2 className="mr-1 h-3.5 w-3.5" />
                  {primaryButtonLabel}
                </>
              ) : (
                <>
                  <Sparkles className="mr-1 h-3.5 w-3.5" />
                  {primaryButtonLabel}
                </>
              )}
            </Button>
          </div>
          <div className="mt-1 flex flex-wrap items-center justify-between gap-1.5 border-t border-border/60 pt-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] leading-4 text-muted-foreground">{progressText}</span>
              {currentStep && (
                <span className="max-w-[260px] truncate text-[11px] leading-4 text-muted-foreground">{currentStep}</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
